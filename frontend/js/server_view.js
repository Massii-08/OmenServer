const ServerView = {
 serverId: null,
 serverData: null,
 currentTab: 'dashboard',
 _ws: null,

 async open(id) {
 this.serverId = id;
 this.currentTab = 'dashboard';
 const content = document.getElementById('module-content');
 content.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted)">${Lang.t('common.loading')}</div>`;
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
 const isPending = !!this._pendingAction;
 const isRunning = !isPending && s.status === 'running';
 const isStopped = !isPending && s.status !== 'running';

 const u = Auth.getUser();
 const al = s.access_level || 'view_only';
 const canManage = al === 'owner' || al === 'manage';
 const canStart = canManage || al === 'start';

 let statusColor, statusText, actionBtns;
 if (isPending) {
 const labels = { start: Lang.t('sv.starting'), stop: Lang.t('sv.stopping'), restart: Lang.t('sv.restarting') };
 statusColor = 'var(--warning)';
 statusText = ` ${labels[this._pendingAction] || '…'}`;
 actionBtns = `<button class="btn btn-sm btn-secondary" disabled style="opacity:0.5;width:100%;">${Lang.t('sv.wait')}</button>`;
 } else if (isRunning) {
 statusColor = 'var(--accent)';
 statusText = ' ' + Lang.t('sv.running');
 actionBtns = canManage ? `
 <button class="btn btn-sm btn-secondary" onclick="ServerView.action('stop')">Stop</button><button class="btn btn-sm btn-secondary" onclick="ServerView.action('restart')">Restart</button>` : '';
 } else {
 statusColor = 'var(--text-muted)';
 statusText = ' ' + Lang.t('sv.stopped');
 actionBtns = canStart ? `<button class="btn btn-sm btn-primary" onclick="ServerView.action('start')">${Lang.t('common.start')}</button>` : '';
 }

 content.innerHTML = `
 <div class="sv-layout"><div id="sv-sidebar" class="sv-sidebar"><div class="sv-server-card"><div class="sv-server-name">${s.name || 'Serveur'}</div><div class="sv-status-text" style="color:${statusColor};">${statusText}</div><div class="sv-action-btns">${actionBtns}</div></div>
 ${this._sidebarItems()}
 </div><div id="sv-content" class="sv-main">
 ${this._tabContent()}
 </div></div>`;
 this._bindEvents();
 },

 _sidebarItems() {
 const st = (this.serverData?.server_type || 'VANILLA').toUpperCase();
 const isPlugin = ['PAPER','SPIGOT','BUKKIT','PURPUR','FOLIA'].includes(st);
 const isMod = ['FORGE','FABRIC','NEOFORGE','QUILT'].includes(st);
 const isSteam = !!(this.serverData?.steam_app_id); // Jeu Steam (ARK, Valheim, GMod...)

 const u = Auth.getUser();
 const al = this.serverData?.access_level || 'view_only';
 const canManage = al === 'owner' || al === 'manage';

 const tabs = [
 {id:'dashboard',label:Lang.t('sv.dashboard')},
 ];

 // Tabs accessibles uniquement aux managers/owners
 if (canManage) {
 tabs.push({id:'console',label:Lang.t('sv.console')});
 tabs.push({id:'settings',label:Lang.t('sv.settings')});
 tabs.push({id:'files',label:Lang.t('sv.files')});
 }

 tabs.push({id:'access',label:Lang.t('sv.access')});

 if (canManage) {
 tabs.push({id:'backups',label:Lang.t('sv.backups')});
 tabs.push({id:'scheduler',label:Lang.t('sv.scheduler')});
 }

 tabs.push({id:'monitoring',label:Lang.t('sv.monitoring')});
 tabs.push({id:'history',label:Lang.t('sv.history')});
 // Players tab only for managers
 if (canManage) {
 tabs.push({id:'players',label:Lang.t('sv.players')});
 }

 // Afficher Plugins seulement pour Paper/Spigot/Bukkit/Purpur
 if (isPlugin && canManage) {
 tabs.push({id:'mods',label:Lang.t('sv.plugins')});
 }
 // Afficher Mods seulement pour Forge/Fabric/NeoForge/Quilt
 if (isMod && canManage) {
 tabs.push({id:'mods',label:Lang.t('sv.mods')});
 }
 // Steam Workshop pour les jeux Steam (ARK, Valheim, GMod, CS2, Terraria, Palworld)
 if (isSteam && canManage) {
 tabs.push({id:'workshop',label:Lang.t('sv.workshop')});
 }
 // Datapacks, worlds, database, version pour les owners/admins
 if (canManage) {
 tabs.push({id:'datapacks',label:Lang.t('sv.datapacks')});
 tabs.push({id:'worlds',label:Lang.t('sv.worlds')});
 tabs.push({id:'database',label:Lang.t('sv.database')});
 tabs.push({id:'version',label:Lang.t('sv.version')});
 }
 tabs.push({id:'notifications',label:Lang.t('sv.notifications')});

 let deleteBtn = '';
 if (canManage) {
 deleteBtn = `
 <div class="sv-nav-divider"></div><a class="sv-tab danger" onclick="ServerView._deleteServerPrompt()">
 ${Lang.t('sv.delete')}
 </a>`;
 }

 // Share button for owners
 let shareBtn = '';
 if (u && (u.is_admin || this.serverData?.owner_id === u?.id)) {
 shareBtn = `
 <a class="sv-tab share" onclick="SharingModal.open(${this.serverId},'server')">
 ${Lang.t('sharing.title')}
 </a>`;
 }

 return tabs.map(t =>`
 <a class="sv-tab ${this.currentTab===t.id?'active':''}" onclick="ServerView.switchTab('${t.id}')">
 ${t.label}
 </a>
 `).join('') + shareBtn + deleteBtn;
 },

 switchTab(tab) {
 if (this._ws) { this._ws.close(); this._ws = null; }
 if (typeof SvMonitoring !== 'undefined') SvMonitoring.stop();
 this.currentTab = tab;

 const isPending = !!this._pendingAction;
 const isRunning = !isPending && this.serverData?.status === 'running';
 const u = Auth.getUser();
 const al = this.serverData?.access_level || 'view_only';
 const canManage = al === 'owner' || al === 'manage';
 const canStart = canManage || al === 'start';
 let statusColor, statusText, actionBtns;
 if (isPending) {
 const labels = { start: Lang.t('sv.starting'), stop: Lang.t('sv.stopping'), restart: Lang.t('sv.restarting') };
 statusColor = 'var(--warning)';
 statusText = ` ${labels[this._pendingAction] || '…'}`;
 actionBtns = `<button class="btn btn-sm btn-secondary" disabled style="opacity:0.5;width:100%;">${Lang.t('sv.wait')}</button>`;
 } else if (isRunning) {
 statusColor = 'var(--accent)';
 statusText = ' ' + Lang.t('sv.running');
 actionBtns = canManage ? `
 <button class="btn btn-sm btn-secondary" onclick="ServerView.action('stop')">Stop</button><button class="btn btn-sm btn-secondary" onclick="ServerView.action('restart')">Restart</button>` : '';
 } else {
 statusColor = 'var(--text-muted)';
 statusText = ' ' + Lang.t('sv.stopped');
 actionBtns = canStart ? `<button class="btn btn-sm btn-primary" onclick="ServerView.action('start')">${Lang.t('common.start')}</button>` : '';
 }

 document.getElementById('sv-sidebar').innerHTML = `
 <div class="sv-server-card"><div class="sv-server-name">${this.serverData?.name||'Serveur'}</div><div class="sv-status-text" style="color:${statusColor};">${statusText}</div><div class="sv-action-btns">${actionBtns}</div></div>
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
 case 'workshop': return this._workshopTab();
 case 'datapacks': return this._datapacksTab();
 case 'settings': return SvSettings.render(this.serverData, this.serverId);
 case 'files': return SvFiles.render(this.serverId);
 case 'monitoring': return SvMonitoring.render(this.serverId);
 case 'access': return SvAccess.render(this.serverData, this.serverId);
 case 'players': return SvPlayers.render(this.serverId);
 case 'history': return SvHistory.render(this.serverId);
 case 'notifications': return this._notificationsTab();
 case 'version': return this._versionTab();
 case 'worlds': return this._worldsTab();
 case 'database': return this._databaseTab();
 default: return '<p>Section en cours de développement</p>';
 }
 },

 _dashboardTab() {
 const s = this.serverData;
 const isPending = !!this._pendingAction;
 const isRunning = !isPending && s.status === 'running';
 const addr = `${GameServer._serverIP || 'localhost'}:${s.port||25565}`;
 const displayAlias = s.connect_alias || null;
 const game = GameServer._games?.find(g =>g.id === s.game_type);
 const gameIcon = game ? game.icon : '';
 const gameName = game ? game.name : (s.game_type || 'minecraft');
 
 // Statut avec gestion du pending
 let uptimeHtml;
 if (isPending) {
 const labels = { start: Lang.t('sv.starting'), stop: Lang.t('sv.stopping'), restart: Lang.t('sv.restarting') };
 uptimeHtml = `<span style="color:var(--warning);font-weight:600;">${labels[this._pendingAction]}</span>`;
 } else if (isRunning) {
 uptimeHtml = '<span style="color:var(--accent);font-weight:600;">' + Lang.t('gs.online') + '</span>';
 } else {
 uptimeHtml = '<span style="color:var(--text-muted);">' + Lang.t('gs.offline') + '</span>';
 }
 
 // Boutons avec gestion du pending
 const u2 = Auth.getUser();
 const al2 = s.access_level || 'view_only';
 const canManage = al2 === 'owner' || al2 === 'manage';
 const canStart = canManage || al2 === 'start';
 const isOwnerOrAdmin = u2 && (u2.is_admin || s.owner_id === u2?.id);
 let controlBtns;
 if (isPending) {
 const pendingLabels = { start: Lang.t('sv.starting'), stop: Lang.t('sv.stopping'), restart: Lang.t('sv.restarting') };
 controlBtns = `<button class="btn btn-secondary" disabled style="flex:1;opacity:0.6;">${pendingLabels[this._pendingAction]}</button>`;
 } else if (isRunning) {
 controlBtns = canManage ? `
 <button class="btn btn-danger" onclick="ServerView.action('stop')" style="flex:1;">${Lang.t('common.stop')}</button><button class="btn btn-secondary" onclick="ServerView.action('restart')" style="flex:1;">${Lang.t('common.restart')}</button>` : '';
 } else {
 controlBtns = canStart ? `<button class="btn btn-primary" onclick="ServerView.action('start')" style="flex:1;">${Lang.t('common.start')}</button>` : '';
 }
 
 setTimeout(() =>this._loadDashboardStats(), 100);
 
 return `
 <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;"><h2 style="margin:0;">${Lang.t('sv.dashboard')}</h2><button class="btn btn-secondary btn-sm" onclick="App.navigateTo('game_server')">${Lang.t('sv.back')}</button></div><!-- Boutons de contrôle --><div style="display:flex;gap:8px;margin-bottom:20px;">
 ${controlBtns}
 </div><!-- Stats principales --><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px;"><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;text-align:center;"><div style="font-size:24px;margin-bottom:4px;">${gameIcon}</div><div style="font-size:12px;color:var(--text-muted);">${Lang.t('sv.game')}</div><div style="font-size:14px;font-weight:600;margin-top:2px;">${gameName}</div></div><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;text-align:center;"><div style="font-size:24px;margin-bottom:4px;"></div><div style="font-size:12px;color:var(--text-muted);">${Lang.t('sv.status')}</div><div style="font-size:14px;margin-top:2px;">${uptimeHtml}</div></div><div style="background:${isRunning ? 'rgba(96,165,250,0.1)' : 'var(--bg-elev-1)'};padding:16px;border-radius:10px;text-align:center;border:${isRunning ? '1px solid rgba(96,165,250,0.2)' : 'none'};"><div style="font-size:24px;margin-bottom:4px;"></div><div style="font-size:12px;color:var(--text-muted);">${Lang.t('sv.players')}</div><div style="font-size:14px;font-weight:600;margin-top:2px;color:${isRunning ? 'var(--info)' : 'var(--text-muted)'};" id="sv-dash-players">${isRunning ? `${s.player_count || 0}/${s.player_max || 20}` : '—'}</div></div><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;text-align:center;"><div style="font-size:24px;margin-bottom:4px;"></div><div style="font-size:12px;color:var(--text-muted);">RAM</div><div style="font-size:14px;font-weight:600;margin-top:2px;" id="sv-dash-ram">${((s.memory_mb||1024) / 1024).toFixed(1).replace(/\.0$/, '')} Go</div></div><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;text-align:center;"><div style="font-size:24px;margin-bottom:4px;"></div><div style="font-size:12px;color:var(--text-muted);">CPU</div><div style="font-size:14px;font-weight:600;margin-top:2px;" id="sv-dash-cpu">${s.cpu_percent||100}%</div></div></div><!-- Infos connexion (style Minestrator) --><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;"><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;display:flex;align-items:center;gap:14px;"><div style="width:44px;height:44px;border-radius:50%;background:rgba(74,222,128,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;"></div><div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${addr}');this.textContent='';setTimeout(()=>this.textContent='',1200)" style="padding:2px 6px;font-size:11px;"></button><span style="font-family:monospace;font-size:15px;font-weight:700;color:var(--accent);">${addr}</span></div><div style="display:flex;align-items:center;gap:8px;">
 ${displayAlias ? `
 <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${displayAlias}');this.textContent='';setTimeout(()=>this.textContent='',1200)" style="padding:2px 6px;font-size:11px;"></button><span style="font-family:monospace;font-size:14px;color:var(--text);">${displayAlias}</span>
 ` : `
 <span style="font-size:12px;color:var(--text-muted);font-style:italic;">${Lang.t('sv.no_alias')}</span>
 `}
 ${isOwnerOrAdmin ? `<button class="btn btn-secondary btn-sm" onclick="ServerView._editAlias()" style="padding:3px 10px;font-size:11px;color:var(--accent);border-color:var(--accent);">${Lang.t('sv.edit_alias')}</button>` : ''}
 </div></div></div><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;"><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Version</div><div style="font-size:16px;font-weight:600;" data-version-display>${(s.server_type||'VANILLA')} · v${s.version === 'LATEST' ? (this._resolvedVersion || 'latest') : (s.version||'?')}</div></div></div><!-- Raccourcis rapides -->
 ${canManage ? `
 <div style="margin-bottom:20px;"><div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-muted);">${Lang.t('sv.quick_actions')}</div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;"><button class="btn btn-secondary" onclick="ServerView.switchTab('console')" style="padding:12px 8px;font-size:12px;">${Lang.t('sv.console')}</button><button class="btn btn-secondary" onclick="ServerView.switchTab('files')" style="padding:12px 8px;font-size:12px;">${Lang.t('sv.files')}</button><button class="btn btn-secondary" onclick="ServerView.switchTab('backups')" style="padding:12px 8px;font-size:12px;">${Lang.t('sv.backups')}</button><button class="btn btn-secondary" onclick="ServerView.switchTab('players')" style="padding:12px 8px;font-size:12px;">${Lang.t('sv.players')}</button></div></div>` : ''}

 <!-- Stats Docker live --><div id="sv-dash-docker" style="background:var(--bg-elev-1);padding:16px;border-radius:10px;"><div style="font-size:13px;font-weight:600;margin-bottom:8px;">Docker — Ressources en temps réel</div><div style="color:var(--text-muted);font-size:12px;">${Lang.t('common.loading')}</div></div>

 ${canManage ? `<!-- Mini-logs (manage only) --><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;margin-top:16px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><span style="font-size:13px;font-weight:600;">${Lang.t('sv.last_logs')}</span><div style="display:flex;gap:6px;align-items:center;"><button class="btn btn-secondary btn-sm" onclick="ServerView._refreshDashLogs()" style="font-size:11px;padding:3px 8px;"></button><button class="btn btn-secondary btn-sm" onclick="ServerView.switchTab('console')" style="font-size:11px;padding:3px 8px;">${Lang.t('sv.open_console')}</button></div></div><div id="sv-dash-logs" style="background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:11px;padding:10px;border-radius:6px;height:180px;overflow-y:auto;white-space:pre-wrap;line-height:1.5;">${Lang.t('common.loading')}</div></div>` : ''}`;
 },

 _consoleTab() {
 setTimeout(() =>this._startConsoleWS(), 100);
 return `
 <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;"><h2 style="margin:0;">Console</h2><div style="display:flex;gap:8px;"><span id="sv-console-status" style="font-size:11px;padding:4px 8px;border-radius:4px;background:var(--bg-elev-1);color:var(--text-muted);">⏳ ${Lang.t('gs.connecting')}</span><button class="btn btn-secondary btn-sm" onclick="document.getElementById('sv-console-logs').innerHTML=''">${Lang.t('sv.console_clear')}</button></div></div><div id="sv-console-logs" style="background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:12px;padding:12px;border-radius:8px;height:400px;overflow-y:auto;white-space:pre-wrap;line-height:1.5;"></div><div style="display:flex;gap:8px;margin-top:8px;"><input id="sv-console-input" class="form-input" placeholder="${Lang.t('gs.send_cmd')}" style="flex:1;font-family:monospace;" onkeydown="if(event.key==='Enter')ServerView.sendCommand()"/><button class="btn btn-primary" onclick="ServerView.sendCommand()">${Lang.t('gs.send')}</button></div><p style="font-size:11px;color:var(--text-muted);margin-top:8px;">Les commandes sont envoyées via rcon-cli. Exemples : <code>say Bonjour</code>, <code>list</code>, <code>op Massii_08</code></p>`;
 },

 async _editAlias() {
 const s = this.serverData;
 const currentAlias = s?.connect_alias || '';
 const newAlias = prompt(
 Lang.t('sv.alias_prompt') || 'Alias de connexion (ex: monserveur.omen)\nLaisse vide pour l\'alias par défaut.',
 currentAlias
 );
 if (newAlias === null) return; // Cancel

 const r = await Auth.apiCall(`/api/servers/${s.id}/alias`, {
 method: 'PUT',
 body: JSON.stringify({ alias: newAlias.trim() })
 });

 if (r && r.ok) {
 const data = await r.json();
 this.serverData.connect_alias = data.alias;
 Toast.success(Lang.t('sv.alias_updated') || 'Alias mis à jour');
 this.switchTab(this._currentTab || 'dashboard');
 } else {
 const err = r ? await r.json().catch(() =>({})) : {};
 Toast.error(err.detail || Lang.t('common.error'));
 }
 },

 _appendLog(text, color) {
 const logs = document.getElementById('sv-console-logs');
 if (!logs) return;
 const span = document.createElement('span');

 // Auto-coloration si pas de couleur explicite
 if (!color) {
 const t = text.toLowerCase();
 if (t.includes('error') || t.includes('exception') || t.includes('severe') || t.includes('failed')) {
 color = 'var(--danger)'; // Rouge — erreurs
 } else if (t.includes('warn')) {
 color = 'var(--warning)'; // Orange — warnings
 } else if (t.includes('joined the game') || t.includes('left the game') || t.includes('logged in') || t.includes('lost connection')) {
 color = 'var(--accent)'; // Vert — joueurs
 } else if (t.includes('starting minecraft') || t.includes('done (') || t.includes('server started') || t.includes('preparing') || t.includes('loading')) {
 color = 'var(--violet)'; // Violet — démarrage
 } else if (t.includes('info') && t.includes(']: ')) {
 // Format [HH:MM:SS INFO]: ... — extraire le contenu
 color = '#8b949e'; // Gris clair — info standard
 } else if (t.startsWith('[') && t.includes('/')) {
 color = '#8b949e'; // Gris — logs horodatés standards
 } else {
 color = '#c9d1d9'; // Défaut
 }
 }

 span.style.color = color;
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

 this._ws.onopen = () =>{
 if (statusEl) { statusEl.textContent = 'Connecté'; statusEl.style.color = 'var(--accent)'; }
 this._appendLog('--- Console connectée ---', 'var(--accent)');
 };

 this._ws.onmessage = (e) =>{
 try {
 const msg = JSON.parse(e.data);
 if (msg.type === 'log') {
 this._appendLog(msg.data);
 } else if (msg.type === 'info') {
 this._appendLog(msg.data, 'var(--info)');
 } else if (msg.type === 'error') {
 this._appendLog('' + (msg.message || msg.data), 'var(--danger)');
 } else {
 this._appendLog(JSON.stringify(msg));
 }
 } catch {
 // Message texte brut
 this._appendLog(e.data);
 }
 };

 this._ws.onclose = () =>{
 if (statusEl) { statusEl.textContent = 'Déconnecté'; statusEl.style.color = 'var(--danger)'; }
 this._appendLog('--- Console déconnectée ---', 'var(--danger)');
 };

 this._ws.onerror = () =>{
 this._appendLog('--- Erreur de connexion WebSocket ---', 'var(--danger)');
 };
 },

 sendCommand() {
 const input = document.getElementById('sv-console-input');
 if (input && input.value.trim() && this._ws && this._ws.readyState === WebSocket.OPEN) {
 const cmd = input.value.trim();
 // Afficher la commande localement
 this._appendLog('>' + cmd, 'var(--warning)');
 // Envoyer au format attendu par le backend
 this._ws.send(JSON.stringify({type: 'command', data: cmd}));
 input.value = '';
 }
 },

 _backupsTab() {
 setTimeout(() =>this._loadBackups(), 50);
 return `<h2>${Lang.t('sv.bk.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">${Lang.t('sv.bk.desc')}</p><!-- Formulaire de création manuelle --><div style="background:var(--bg-elev-1);padding:14px;border-radius:10px;margin-bottom:16px;"><div style="font-size:13px;font-weight:600;margin-bottom:8px;">${Lang.t('sv.bk.new')}</div><div style="display:flex;gap:8px;align-items:center;"><input id="sv-backup-name" class="form-input" placeholder="${Lang.t('sv.bk.name_hint')}" style="flex:1;" /><button class="btn btn-primary btn-sm" id="sv-backup-btn" onclick="ServerView._createBackup()">${Lang.t('sv.bk.create')}</button></div></div><!-- Tabs Auto / Manuel --><div style="display:flex;gap:4px;margin-bottom:12px;"><button class="btn btn-sm" id="sv-bk-tab-manual" onclick="ServerView._switchBackupTab('manual')" style="font-weight:600;">${Lang.t('sv.bk.tab_manual')}</button><button class="btn btn-sm btn-secondary" id="sv-bk-tab-auto" onclick="ServerView._switchBackupTab('auto')">${Lang.t('sv.bk.tab_auto')}</button></div><div id="sv-backups-list"><div style="color:var(--text-muted)">${Lang.t('common.loading')}</div></div>`;
 },

 _backupTab: 'manual',

 _switchBackupTab(tab) {
 this._backupTab = tab;
 // Highlight active tab
 const manBtn = document.getElementById('sv-bk-tab-manual');
 const autoBtn = document.getElementById('sv-bk-tab-auto');
 if (manBtn && autoBtn) {
 if (tab === 'manual') {
 manBtn.className = 'btn btn-sm btn-primary';
 autoBtn.className = 'btn btn-sm btn-secondary';
 } else {
 manBtn.className = 'btn btn-sm btn-secondary';
 autoBtn.className = 'btn btn-sm btn-primary';
 }
 }
 this._loadBackups();
 },

 async _loadBackups() {
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups`);
 const el = document.getElementById('sv-backups-list');
 if (!el) return;
 if (!r || !r.ok) { el.innerHTML=`<p style="color:var(--danger)">${Lang.t('common.error')}</p>`; return; }
 const data = await r.json();

 const tab = this._backupTab || 'manual';
 const backups = tab === 'auto' ? (data.auto || []) : (data.manual || []);
 const isAuto = tab === 'auto';

 // Info banner
 let banner = '';
 if (isAuto) {
 banner = `<div style="font-size:12px;color:var(--text-muted);padding:8px 12px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:8px;">
 ${Lang.t('sv.bk.auto_desc')}
 <span style="float:right;color:var(--accent);font-weight:600;">${backups.length}/10</span></div>`;
 } else {
 const atLimit = backups.length >= 10;
 banner = `<div style="font-size:12px;color:var(--text-muted);padding:8px 12px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:8px;">
 ${Lang.t('sv.bk.manual_desc')}
 <span style="float:right;color:${atLimit ? 'var(--danger)' : 'var(--accent)'};font-weight:600;">${backups.length}/10</span></div>`;
 if (atLimit) {
 banner += `<div style="font-size:12px;color:var(--danger);padding:6px 12px;margin-bottom:8px;">${Lang.t('sv.bk.limit_reached')}</div>`;
 }
 }

 if (backups.length === 0) {
 el.innerHTML = banner + `<p style="color:var(--text-muted)">${isAuto ? Lang.t('sv.bk.none_auto') : Lang.t('sv.bk.none_manual')}</p>`;
 return;
 }
 
 el.innerHTML = banner + backups.map(b =>{
 // Extraire le nom lisible (avant le timestamp)
 const parts = (b.id||'').split('_');
 const displayName = parts.length >= 3 ? parts.slice(0, -2).join('_') : (b.id || b.filename);
 const btype = b.backup_type || tab;
 
 return `
 <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;" id="sv-bk-${b.id}"><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:14px;">${isAuto ? '' : ''} ${displayName}</div><div style="font-size:11px;color:var(--text-muted);">${b.size_mb||'?'} Mo · ${b.created_at||''}</div></div><div style="display:flex;gap:6px;flex-shrink:0;">
 ${!isAuto ? `<button class="btn btn-sm btn-secondary" onclick="ServerView._renameBackup('${b.id}','${displayName.replace(/'/g,"\\'")}','${btype}')" ></button>` : ''}
 <button class="btn btn-sm btn-secondary" onclick="ServerView._restoreBackup('${b.id}','${btype}')" ></button><button class="btn btn-sm btn-danger" onclick="ServerView._confirmDeleteBackup('${b.id}','${btype}')" ></button></div></div>`;
 }).join('');
 },

 async _createBackup() {
 const btn = document.getElementById('sv-backup-btn');
 const msg = document.getElementById('sv-backup-msg');
 const nameInput = document.getElementById('sv-backup-name');
 const backupName = nameInput ? nameInput.value.trim() : '';
 
 if (btn) btn.disabled = true;
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.bk.creating'); }
 
 const body = backupName ? JSON.stringify({backup_name: backupName}) : null;
 const opts = {method: 'POST'};
 if (body) opts.body = body;
 
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/backup`, opts);
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.bk.created'); }
 if (nameInput) nameInput.value = '';
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 if (btn) btn.disabled = false;
 this._loadBackups();
 },

 async _renameBackup(id, currentName, backupType) {
 const newName = prompt(Lang.t('sv.bk.rename_prompt'), currentName);
 if (!newName || newName.trim() === '' || newName.trim() === currentName) return;
 
 const msg = document.getElementById('sv-backup-msg');
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups/${id}?backup_type=${backupType || 'manual'}`, {
 method: 'PUT',
 body: JSON.stringify({new_name: newName.trim()})
 });
 
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.bk.renamed'); }
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 this._loadBackups();
 },

 async _restoreBackup(id, backupType) {
 if (!confirm(Lang.t('sv.bk.restore_confirm'))) return;
 const msg = document.getElementById('sv-backup-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.bk.restoring'); }
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/restore/${id}?backup_type=${backupType || 'manual'}`,{method:'POST'});
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.bk.restored'); }
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 },

 _confirmDeleteBackup(id, backupType) {
 // Inline confirm — remplace le contenu de la carte par une confirmation
 const row = document.getElementById(`sv-bk-${id}`);
 if (!row) return;
 row.style.background = 'rgba(248,113,113,0.15)';
 row.style.border = '1px solid rgba(248,113,113,0.3)';
 row.innerHTML = `
 <div style="flex:1;"><div style="font-weight:600;color:var(--danger);">${Lang.t('gs.delete_title')}</div><div style="font-size:12px;color:var(--text-muted);">${Lang.t('gs.delete_warn')}</div></div><div style="display:flex;gap:6px;"><button class="btn btn-sm btn-danger" onclick="ServerView._deleteBackup('${id}','${backupType}')">${Lang.t('common.confirm')}</button><button class="btn btn-sm btn-secondary" onclick="ServerView._loadBackups()">${Lang.t('common.cancel')}</button></div>`;
 },

 async _deleteBackup(id, backupType) {
 const msg = document.getElementById('sv-backup-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.bk.deleting'); }
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/backups/${id}?backup_type=${backupType || 'manual'}`,{method:'DELETE'});
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.bk.deleted'); }
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 this._loadBackups();
 },

 _schedulerTab() {
 setTimeout(() =>this._loadTasks(), 50);
 return `<h2>${Lang.t('sv.sched.title')}</h2><div style="background:var(--bg-elev-1);padding:14px;border-radius:8px;margin-bottom:14px;"><div class="flex gap-2" style="align-items:flex-end;flex-wrap:wrap;"><div style="flex:1"><label style="font-size:12px;color:var(--text-muted)">${Lang.t('sv.sched.type')}</label><select id="sv-task-type" class="form-input" style="margin-top:4px;"><option value="backup">Backup</option><option value="restart">Restart</option></select></div><div style="flex:1"><label style="font-size:12px;color:var(--text-muted)">${Lang.t('scheduler.mode')}</label><select id="sv-task-mode" class="form-input" style="margin-top:4px;" onchange="ServerView._onTaskModeChange()"><option value="interval">${Lang.t('scheduler.mode_interval')}</option><option value="fixed">${Lang.t('scheduler.mode_fixed')}</option></select></div></div><!-- Mode intervalle --><div id="sv-task-interval-row" style="display:flex;gap:8px;align-items:flex-end;margin-top:8px;"><div style="flex:1"><label style="font-size:12px;color:var(--text-muted)">${Lang.t('sv.sched.interval')}</label><select id="sv-task-interval" class="form-input" style="margin-top:4px;"><option value="1">1h</option><option value="6" selected>6h</option><option value="12">12h</option><option value="24">24h</option></select></div><button class="btn btn-primary" onclick="ServerView._createTask()"></button></div><!-- Mode heure fixe --><div id="sv-task-fixed-row" style="display:none;margin-top:8px;"><div style="display:flex;gap:8px;align-items:flex-end;"><div><label style="font-size:12px;color:var(--text-muted)">${Lang.t('scheduler.time')}</label><input type="time" id="sv-task-time" class="form-input" style="margin-top:4px;" value="08:00" /></div><button class="btn btn-primary" onclick="ServerView._createTask()"></button></div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;"><label style="font-size:12px;color:var(--text-muted);margin-right:4px;">${Lang.t('scheduler.days')}:</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="sv-day-daily" checked onchange="ServerView._onSvDailyToggle(this)">${Lang.t('scheduler.daily')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="mon" disabled>${Lang.t('scheduler.day_mon')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="tue" disabled>${Lang.t('scheduler.day_tue')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="wed" disabled>${Lang.t('scheduler.day_wed')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="thu" disabled>${Lang.t('scheduler.day_thu')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="fri" disabled>${Lang.t('scheduler.day_fri')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="sat" disabled>${Lang.t('scheduler.day_sat')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="sv-day-check" value="sun" disabled>${Lang.t('scheduler.day_sun')}</label></div></div></div><div id="sv-tasks-list"><div style="color:var(--text-muted)">⏳</div></div>`;
 },

 _onTaskModeChange() {
 const mode = document.getElementById('sv-task-mode')?.value || 'interval';
 const intRow = document.getElementById('sv-task-interval-row');
 const fixRow = document.getElementById('sv-task-fixed-row');
 if (intRow) intRow.style.display = mode === 'interval' ? 'flex' : 'none';
 if (fixRow) fixRow.style.display = mode === 'fixed' ? 'block' : 'none';
 },

 _onSvDailyToggle(cb) {
 document.querySelectorAll('.sv-day-check').forEach(c =>{ c.disabled = cb.checked; if (cb.checked) c.checked = false; });
 },

 async _loadTasks() {
 const r = await Auth.apiCall(`/api/scheduler/server/${this.serverId}`);
 const el = document.getElementById('sv-tasks-list');
 if (!r||!r.ok||!el) return;
 const tasks = await r.json();
 if (tasks.length===0) { el.innerHTML=`<p style="color:var(--text-muted)">${Lang.t('sv.sched.none')}</p>`; return; }
 el.innerHTML = tasks.map(t =>{
 const schedInfo = t.schedule_time
 ? `${Lang.t('scheduler.at')} ${t.schedule_time} (${t.schedule_days || 'daily'})`
 : `${Lang.t('sv.sched.every')} ${t.interval_hours}h`;
 return `
 <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;"><div><span style="font-weight:600;">${t.task_type==='backup'?'Backup':'Restart'}</span>· ${schedInfo} <span style="color:${t.enabled?'var(--accent)':'var(--text-muted)'};">${t.enabled?Lang.t('sv.sched.active'):Lang.t('sv.sched.inactive')}</span></div><div class="flex gap-2"><button class="btn btn-sm btn-secondary" onclick="ServerView._toggleTask(${t.id})">${t.enabled?'⏸':''}</button><button class="btn btn-sm btn-danger" onclick="ServerView._deleteTask(${t.id})"></button></div></div>`;
 }).join('');
 },

 async _createTask() {
 const type = document.getElementById('sv-task-type').value;
 const mode = document.getElementById('sv-task-mode')?.value || 'interval';
 const body = { server_id: this.serverId, task_type: type };

 if (mode === 'fixed') {
 body.schedule_time = document.getElementById('sv-task-time')?.value || '08:00';
 const dailyCb = document.getElementById('sv-day-daily');
 if (dailyCb && dailyCb.checked) {
 body.schedule_days = 'daily';
 } else {
 const checked = [...document.querySelectorAll('.sv-day-check:checked')].map(c =>c.value);
 body.schedule_days = checked.length >0 ? checked.join(',') : 'daily';
 }
 } else {
 body.interval_hours = parseInt(document.getElementById('sv-task-interval').value);
 }

 await Auth.apiCall('/api/scheduler/',{method:'POST',body:JSON.stringify(body)});
 this._loadTasks();
 },

 async _toggleTask(id) { await Auth.apiCall(`/api/scheduler/${id}/toggle`,{method:'POST'}); this._loadTasks(); },
 async _deleteTask(id) { await Auth.apiCall(`/api/scheduler/${id}`,{method:'DELETE'}); this._loadTasks(); },

 // ============================================================
 // STEAM WORKSHOP
 // ============================================================

 _workshopTab() {
 const appId = this.serverData?.steam_app_id;
 const gameName = this.serverData?.name || this.serverData?.game_type || '';

 // Onglets internes : Rechercher / Installés
 if (!this._workshopMode) this._workshopMode = 'search';

 const btnSearch = `btn btn-sm ${this._workshopMode==='search'?'btn-primary':'btn-secondary'}`;
 const btnInstalled = `btn btn-sm ${this._workshopMode==='installed'?'btn-primary':'btn-secondary'}`;

 return `
 <h2>${Lang.t('sv.workshop.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">
 ${Lang.t('sv.workshop.desc')} — <strong>${gameName}</strong><span style="font-size:11px;padding:2px 8px;background:rgba(96,165,250,0.15);color:#60a5fa;border-radius:20px;margin-left:8px;">App ID ${appId}</span></p><div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-elev-1);padding:4px;border-radius:8px;width:fit-content;"><button class="${btnSearch}" onclick="ServerView._workshopMode='search';ServerView.switchTab('workshop')">
 ${Lang.t('sv.mod.search')}
 </button><button class="${btnInstalled}" onclick="ServerView._workshopMode='installed';ServerView.switchTab('workshop')">
 ${Lang.t('sv.workshop.installed_tab')}
 </button></div><div id="sv-workshop-content">
 ${this._workshopModeContent()}
 </div>`;
 },

 _workshopModeContent() {
 if (this._workshopMode === 'installed') {
 setTimeout(() =>this._loadWorkshopMods(), 50);
 return `<div id="sv-workshop-installed"><div style="color:var(--text-muted)">${Lang.t('common.loading')}</div></div>`;
 }
 return this._workshopSearchUI();
 },

 _workshopSearchUI() {
 return `
 <div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;margin-bottom:14px;"><div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text);">
 ${Lang.t('sv.workshop.desc')}
 </div><div style="display:flex;gap:8px;"><input id="sv-workshop-url" class="form-input"
 placeholder="${Lang.t('sv.workshop.input_hint')}"
 style="flex:1;"
 onkeydown="if(event.key==='Enter') ServerView._fetchWorkshopItem()" /><button class="btn btn-primary" onclick="ServerView._fetchWorkshopItem()">
 ${Lang.t('sv.workshop.search_btn')}
 </button></div><div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
 Depuis Steam : page du mod → barre d'adresse → copiez le lien complet ou juste le numéro
 </div></div><div id="sv-workshop-result"></div>`;
 },

 async _fetchWorkshopItem() {
 const input = document.getElementById('sv-workshop-url')?.value?.trim();
 if (!input) return;

 const el = document.getElementById('sv-workshop-result');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.workshop.searching')}</div>`;

 const encoded = encodeURIComponent(input);
 const r = await Auth.apiCall(`/api/mods/steam/item/${encoded}`);
 if (!r || !r.ok) {
 const err = r ? await r.json().catch(()=>({})) : {};
 el.innerHTML = `<div style="color:var(--danger)">${err.detail || Lang.t('sv.workshop.invalid_id')}</div>`;
 return;
 }

 const item = await r.json();
 const subs = item.subscriptions >1000000
 ? `${(item.subscriptions/1000000).toFixed(1)}M`
 : item.subscriptions >1000
 ? `${Math.round(item.subscriptions/1000)}k`
 : item.subscriptions;

 const tags = (item.tags || []).slice(0,5)
 .map(t =>`<span style="font-size:10px;padding:1px 6px;background:var(--bg-elev-3);border-radius:4px;margin-right:3px;">${t}</span>`)
 .join('');

 el.innerHTML = `
 <div style="background:var(--bg-elev-1);border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.06);"><div style="display:flex;gap:14px;padding:16px;align-items:flex-start;">
 ${item.preview_url
 ? `<img src="${item.preview_url}" style="width:80px;height:80px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'" />`
 : `<div style="width:80px;height:80px;border-radius:8px;background:var(--bg-elev-3);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;"></div>`
 }
 <div style="flex:1;min-width:0;"><div style="font-size:16px;font-weight:700;margin-bottom:4px;">${item.title || 'Mod Workshop'}</div><div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${item.description || ''}</div><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;margin-bottom:6px;">
 ${item.file_size_mb ? `<span style="color:var(--text-muted);">${item.file_size_mb} Mo</span>` : ''}
 <span style="color:var(--text-muted);">⭐ ${subs} ${Lang.t('sv.workshop.subscriptions')}</span><a href="${item.url}" target="_blank" style="color:var(--info);font-size:11px;">Voir sur Steam</a></div><div style="margin-bottom:8px;">${tags}</div><div style="font-size:11px;color:var(--text-muted);">ID: <code style="background:var(--bg-elev-3);padding:1px 5px;border-radius:3px;">${item.id}</code></div></div></div><div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:12px;"><button class="btn btn-primary" id="sv-workshop-install-btn"
 onclick="ServerView._installWorkshopMod('${item.id}', '${(item.title||'').replace(/'/g,"\\'")}')"
 style="min-width:130px;">
 ${Lang.t('sv.workshop.install_btn')}
 </button></div></div>`;
 },

 async _installWorkshopMod(workshopId, name) {
 const btn = document.getElementById('sv-workshop-install-btn');
 const msg = document.getElementById('sv-workshop-install-msg');
 if (btn) btn.disabled = true;
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.workshop.installing'); }

 const r = await Auth.apiCall('/api/mods/steam/install', {
 method: 'POST',
 body: JSON.stringify({ server_id: this.serverId, workshop_id: workshopId })
 });

 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = `${name} — ${Lang.t('sv.workshop.installed')}`; }
 if (typeof Toast !== 'undefined') Toast.success(`${name} installé !`);
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 if (btn) btn.disabled = false;
 },

 async _loadWorkshopMods() {
 const el = document.getElementById('sv-workshop-installed');
 if (!el) return;

 const r = await Auth.apiCall(`/api/mods/steam/server/${this.serverId}`);
 if (!r || !r.ok) {
 el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`;
 return;
 }

 const data = await r.json();
 const mods = data.mods || [];

 if (mods.length === 0) {
 el.innerHTML = `
 <div style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:12px;"></div><div style="font-size:14px;">${Lang.t('sv.workshop.no_mods')}</div><div style="font-size:12px;margin-top:6px;">${Lang.t('sv.workshop.no_mods_hint')}</div></div>`;
 return;
 }

 el.innerHTML = `<p style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">${mods.length} ${Lang.t('sv.workshop.installed_list')}</p>` +
 mods.map(m =>`
 <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;"><div style="display:flex;align-items:center;gap:10px;"><div><div style="font-weight:600;font-size:13px;">Workshop ID: ${m.workshop_id}</div><div style="font-size:11px;color:var(--text-muted);">${m.size_mb} Mo</div></div></div><div style="display:flex;gap:6px;"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${m.workshop_id}" target="_blank"
 class="btn btn-sm btn-secondary" title="Voir sur Steam"></a><button class="btn btn-sm btn-danger"
 onclick="ServerView._removeWorkshopMod('${m.workshop_id}')">
 ${Lang.t('sv.mod.remove')}
 </button></div></div>`).join('');
 },

 async _removeWorkshopMod(workshopId) {
 if (!confirm(`${Lang.t('sv.workshop.remove_confirm')} (ID: ${workshopId}) ?`)) return;
 const r = await Auth.apiCall(`/api/mods/steam/server/${this.serverId}/${workshopId}`, { method: 'DELETE' });
 if (r && r.ok) {
 if (typeof Toast !== 'undefined') Toast.success(`Mod ${workshopId} supprimé`);
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
 }
 this._loadWorkshopMods();
 },

 // ============================================================
 // FIN STEAM WORKSHOP
 // ============================================================

 _modsTab() {
 const st = (this.serverData?.server_type || 'VANILLA').toUpperCase();
 const isPlugin = ['PAPER','SPIGOT','BUKKIT','PURPUR','FOLIA'].includes(st);
 const isMod = ['FORGE','FABRIC','NEOFORGE','QUILT'].includes(st);
 const ver = this.serverData?.version || '';

 // Default mode based on server type
 if (!this._modMode) this._modMode = isPlugin ? 'plugins' : 'mods';

 const title = isPlugin ? 'Plugins' : ' Mods';
 const desc = isPlugin
 ? `${Lang.t('sv.mod.install_for')} ${st}${ver && ver !== 'LATEST' ? ` (MC ${ver})` : ''}`
 : `${Lang.t('sv.mod.install_mods')} ${st}${ver && ver !== 'LATEST' ? ` (MC ${ver})` : ''}`;

 let buttons = '';
 if (isPlugin) {
 buttons = `
 <button class="btn btn-sm ${this._modMode==='plugins'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='plugins';ServerView.switchTab('mods')">${Lang.t('sv.mod.search')}</button><button class="btn btn-sm ${this._modMode==='installed'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='installed';ServerView.switchTab('mods')">${Lang.t('sv.mod.installed')}</button>`;
 } else {
 buttons = `
 <button class="btn btn-sm ${this._modMode==='mods'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='mods';ServerView.switchTab('mods')">${Lang.t('sv.mod.search')}</button><button class="btn btn-sm ${this._modMode==='installed'?'btn-primary':'btn-secondary'}" onclick="ServerView._modMode='installed';ServerView.switchTab('mods')">${Lang.t('sv.mod.installed')}</button>`;
 }

 return `<h2>${title}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">${desc}</p><div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-elev-1);padding:4px;border-radius:8px;width:fit-content;">
 ${buttons}
 </div><div id="sv-mods-content">${this._modModeContent()}</div>`;
 },

 _modModeContent() {
 if (this._modMode === 'plugins') return this._pluginsSearch();
 if (this._modMode === 'installed') { setTimeout(() =>this._loadInstalledPlugins(), 50); return `<div id="sv-installed-list"><div style="color:var(--text-muted)">${Lang.t('common.loading')}</div></div>`; }
 if (this._modMode === 'mods') return this._modsSearch();
 return '';
 },

 // ============ PLUGINS (Modrinth) ============

 _pluginsSearch() {
 return `
 <div style="display:flex;gap:8px;margin-bottom:12px;"><input id="sv-plugin-q" class="form-input" placeholder="${Lang.t('sv.mod.search_plugin_hint')}" style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchPlugins()" /><button class="btn btn-primary" onclick="ServerView._searchPlugins()">${Lang.t('sv.mod.search')}</button></div><div id="sv-plugin-results"><div style="color:var(--text-muted)">${Lang.t('sv.mod.search_plugin_desc')}</div></div>`;
 },

 async _searchPlugins() {
 const q = document.getElementById('sv-plugin-q')?.value?.trim();
 if (!q) return;
 const el = document.getElementById('sv-plugin-results');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.mod.searching_modrinth')}</div>`;

 const ver = this.serverData?.version || '';
 const verParam = ver && ver !== 'LATEST' ? `&game_version=${encodeURIComponent(ver)}` : '';
 const r = await Auth.apiCall(`/api/plugins/search?q=${encodeURIComponent(q)}${verParam}`);
 if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
 const data = await r.json();
 const plugins = data.plugins || [];

 if (plugins.length === 0) { el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.mod.no_results')}</div>`; return; }

 el.innerHTML = plugins.map(p =>{
 const dl = p.downloads >1000 ? `${Math.round(p.downloads/1000)}k` : p.downloads;
 const cats = (p.categories||[]).slice(0,3).map(c =>`<span style="font-size:10px;padding:1px 5px;background:var(--bg-elev-3);border-radius:3px;margin-right:3px;">${c}</span>`).join('');
 return `
 <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;"><img src="${p.icon_url||''}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'" /><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:14px;">${p.name}</div><div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.description||''}</div><div style="margin-top:4px;">${cats} <span style="font-size:10px;color:var(--text-muted);">${dl} ${Lang.t('sv.mod.downloads')}</span></div></div><button class="btn btn-primary btn-sm" onclick="ServerView._showPluginVersions('${p.id}','${(p.name||'').replace(/'/g,"\\'")}')">${Lang.t('sv.mod.install')}</button></div>`;
 }).join('');
 },

 async _showPluginVersions(projectId, name) {
 const el = document.getElementById('sv-plugin-results');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('common.loading')}</div>`;

 const r = await Auth.apiCall(`/api/plugins/${projectId}/versions`);
 if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
 const data = await r.json();
 const versions = data.versions || [];

 el.innerHTML = `
 <button class="btn btn-secondary btn-sm" onclick="ServerView._searchPlugins()">${Lang.t('sv.mod.back')}</button><span style="font-weight:600;margin-left:8px;font-size:15px;">${name}</span><div style="margin-top:12px;">
 ${versions.map(v =>{
 const loaders = (v.loaders||[]).map(l =>`<span style="font-size:10px;padding:1px 5px;background:var(--info);color:#fff;border-radius:3px;margin-right:3px;">${l}</span>`).join('');
 const gameVers = (v.game_versions||[]).slice(-3).join(', ');
 return `
 <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;"><div><span style="font-weight:600;font-size:13px;">${v.name || v.version_number}</span><span style="font-size:11px;color:var(--text-muted);margin-left:6px;">(${v.size_mb} Mo)</span><div style="margin-top:3px;">${loaders} <span style="font-size:10px;color:var(--text-muted);">MC ${gameVers}</span></div></div><button class="btn btn-primary btn-sm" onclick="ServerView._installPlugin('${name.replace(/'/g,"\\'")}','${v.download_url}','${v.filename}')">${Lang.t('sv.mod.install')}</button></div>`;
 }).join('')}
 </div>`;
 },

 async _installPlugin(name, url, filename) {
 const msg = document.getElementById('sv-plugin-install-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.mod.installing'); }

 const r = await Auth.apiCall('/api/plugins/install', {
 method: 'POST',
 body: JSON.stringify({server_id: this.serverId, plugin_name: name, download_url: url, filename: filename})
 });

 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = `${name} ${Lang.t('sv.mod.installed_restart')}`; }
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
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
 el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('sv.mod.no_plugins')}<br><span style="font-size:12px;">${Lang.t('sv.mod.no_plugins_hint')}</span></div>`;
 return;
 }

 el.innerHTML = `<p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">${plugins.length} ${Lang.t('sv.mod.plugin_count')}</p>` +
 plugins.map(p =>`
 <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:4px;"><div style="display:flex;align-items:center;gap:8px;"><div><div style="font-weight:600;font-size:13px;">${p.filename}</div><div style="font-size:11px;color:var(--text-muted);">${p.size_mb} Mo</div></div></div><button class="btn btn-sm btn-danger" onclick="ServerView._removePlugin('${p.filename.replace(/'/g,"\\'")}')">${Lang.t('sv.mod.remove')}</button></div>`).join('');
 },

 async _removePlugin(filename) {
 if (!confirm(`${Lang.t('sv.mod.remove_confirm')} "${filename}" ?`)) return;
 await Auth.apiCall(`/api/plugins/server/${this.serverId}/${encodeURIComponent(filename)}`, {method: 'DELETE'});
 this._loadInstalledPlugins();
 },

 // ============ MODS (CurseForge) ============

 _modsSearch() {
 const ver = this.serverData?.version || '';
 const verHint = ver && ver !== 'LATEST' ? ` MC ${ver}` : '';
 return `
 <div style="display:flex;gap:8px;margin-bottom:12px;"><input id="sv-mods-q" class="form-input" placeholder="${Lang.t('sv.mod.search_mod_hint')}${verHint}" style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchMods()" /><button class="btn btn-primary" onclick="ServerView._searchMods()"></button></div><div id="sv-mods-results"><div style="color:var(--text-muted)">${Lang.t('sv.mod.search_mod_desc')}</div></div>`;
 },

 async _searchMods() {
 const q = document.getElementById('sv-mods-q')?.value?.trim();
 const cat = 'mods';
 if (!q) return;
 const el = document.getElementById('sv-mods-results');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.mod.searching_curseforge')}</div>`;
 const ver = this.serverData?.version || '';
 const verParam = ver && ver !== 'LATEST' ? `&game_version=${encodeURIComponent(ver)}` : '';
 const r = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(q)}&category=${cat}${verParam}`);
 if (!r||!r.ok) { el.innerHTML=`<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
 const data = await r.json();
 const mods = data.mods||[];
 if (mods.length===0) { el.innerHTML=`<div style="color:var(--text-muted)">${Lang.t('sv.mod.no_results')}</div>`; return; }
 el.innerHTML = mods.map(m =>`
 <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;"><img src="${m.icon_url||''}" style="width:36px;height:36px;border-radius:6px;" onerror="this.style.display='none'"/><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;">${m.name}</div><div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.summary||''}</div></div><button class="btn btn-primary btn-sm" onclick="ServerView._showModFiles(${m.id},'${(m.name||'').replace(/'/g,"\\'")}')"></button></div>`).join('');
 },

 async _showModFiles(modId, name) {
 const el = document.getElementById('sv-mods-results');
 if (!el) return;
 const r = await Auth.apiCall(`/api/mods/${modId}/files`);
 if (!r||!r.ok) return;
 const files = (await r.json()).files||[];
 el.innerHTML = `<button class="btn btn-secondary btn-sm" onclick="ServerView._searchMods()">${Lang.t('sv.mod.back')}</button><span style="font-weight:600;margin-left:8px;">${name}</span><br><br>` +
 files.slice(0,8).map(f =>`
 <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;"><div><span style="font-size:13px;">${f.name}</span><span style="color:var(--text-muted);font-size:11px;">(${f.size_mb}Mo)</span></div>
 ${f.download_url?`<button class="btn btn-primary btn-sm" onclick="ServerView._installMod('${name.replace(/'/g,"\\'")}','${f.download_url}','${f.name}')"></button>`:''}
 </div>`).join('');
 },

 // ============ DATAPACKS (CurseForge) ============

 _datapacksTab() {
 this._dpMode = this._dpMode || 'search';
 return `<h2>${Lang.t('sv.dp.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">${Lang.t('sv.dp.desc')}</p><div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-elev-1);padding:4px;border-radius:8px;width:fit-content;"><button class="btn btn-sm ${this._dpMode==='search'?'btn-primary':'btn-secondary'}" onclick="ServerView._dpMode='search';ServerView.switchTab('datapacks')">${Lang.t('sv.mod.search')}</button><button class="btn btn-sm ${this._dpMode==='installed'?'btn-primary':'btn-secondary'}" onclick="ServerView._dpMode='installed';ServerView.switchTab('datapacks')">${Lang.t('sv.mod.installed')}</button></div><div id="sv-dp-content">${this._dpModeContent()}</div>`;
 },

 _dpModeContent() {
 if (this._dpMode === 'installed') {
 setTimeout(() =>this._loadInstalledDatapacks(), 50);
 return `<div id="sv-dp-installed"><div style="color:var(--text-muted)">${Lang.t('common.loading')}</div></div>`;
 }
 return this._dpSearchUI();
 },

 _dpSearchUI() {
 return `
 <div style="display:flex;gap:8px;margin-bottom:12px;"><input id="sv-dp-q" class="form-input" placeholder="${Lang.t('sv.dp.search_hint')}" style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchDatapacks()" /><button class="btn btn-primary" onclick="ServerView._searchDatapacks()">${Lang.t('sv.mod.search')}</button></div><div id="sv-dp-results"><div style="color:var(--text-muted)">${Lang.t('sv.dp.search_desc')}</div></div>`;
 },

 async _searchDatapacks() {
 const q = document.getElementById('sv-dp-q')?.value?.trim();
 if (!q) return;
 const el = document.getElementById('sv-dp-results');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.mod.searching_curseforge')}</div>`;

 const ver = this.serverData?.version || '';
 const verParam = ver && ver !== 'LATEST' ? `&game_version=${encodeURIComponent(ver)}` : '';
 const r = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(q)}&category=datapacks${verParam}`);
 if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
 const data = await r.json();
 const mods = data.mods || [];
 if (mods.length === 0) { el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.mod.no_results')}</div>`; return; }

 el.innerHTML = mods.map(m =>{
 const dl = m.downloads >1000000 ? `${(m.downloads/1000000).toFixed(1)}M` : m.downloads >1000 ? `${Math.round(m.downloads/1000)}k` : m.downloads;
 return `
 <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;"><img src="${m.icon_url||''}" style="width:36px;height:36px;border-radius:6px;" onerror="this.style.display='none'"/><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:13px;">${m.name}</div><div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.summary||''}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${dl} ${Lang.t('sv.mod.downloads')}</div></div><button class="btn btn-primary btn-sm" onclick="ServerView._showDpFiles(${m.id},'${(m.name||'').replace(/'/g,"\\'")}')">${Lang.t('sv.dp.versions')}</button></div>`;
 }).join('');
 },

 async _showDpFiles(modId, name) {
 const el = document.getElementById('sv-dp-results');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('common.loading')}</div>`;

 const r = await Auth.apiCall(`/api/mods/${modId}/files`);
 if (!r||!r.ok) { el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
 const files = (await r.json()).files || [];

 el.innerHTML = `
 <button class="btn btn-secondary btn-sm" onclick="ServerView._searchDatapacks()">${Lang.t('sv.mod.back')}</button><span style="font-weight:600;margin-left:8px;font-size:15px;">${name}</span><div style="margin-top:12px;">
 ${files.slice(0,10).map(f =>{
 const mcVers = (f.game_versions||[]).filter(v =>/^\d/.test(v)).join(', ') || '?';
 const type = f.release_type || '';
 const typeColor = type === 'Release' ? 'var(--accent)' : type === 'Beta' ? 'var(--warning)' : 'var(--text-muted)';
 return `
 <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;"><div><span style="font-size:13px;font-weight:600;">${f.name}</span><span style="color:var(--text-muted);font-size:11px;">(${f.size_mb} Mo)</span><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">MC ${mcVers} · <span style="color:${typeColor};">${type}</span></div></div>
 ${f.download_url ? `<button class="btn btn-primary btn-sm" onclick="ServerView._installDatapack('${name.replace(/'/g,"\\'") }','${f.download_url}','${f.name}')">${Lang.t('sv.mod.install')}</button>` : ''}
 </div>`;
 }).join('')}
 </div>`;
 },

 async _installDatapack(name, url, filename) {
 const msg = document.getElementById('sv-dp-install-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.mod.installing'); }

 const r = await Auth.apiCall('/api/mods/datapacks/install', {
 method: 'POST',
 body: JSON.stringify({server_id: this.serverId, mod_name: name, download_url: url, filename: filename})
 });

 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = `${name} ${Lang.t('sv.mod.installed_restart')}`; }
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 },

 async _loadInstalledDatapacks() {
 const el = document.getElementById('sv-dp-installed');
 if (!el) return;

 const r = await Auth.apiCall(`/api/mods/datapacks/${this.serverId}`);
 const datapacks = (r && r.ok) ? ((await r.json()).datapacks || []) : [];

 if (datapacks.length === 0) {
 el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('sv.dp.no_installed')}<br><span style="font-size:12px;">${Lang.t('sv.dp.no_installed_hint')}</span></div>`;
 return;
 }

 el.innerHTML = `<p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">${datapacks.length} ${Lang.t('sv.dp.count')}</p>` +
 datapacks.map(p =>`
 <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:4px;"><div style="display:flex;align-items:center;gap:8px;"><span>${p.is_dir ? '' : ''}</span><div><div style="font-weight:600;font-size:13px;">${p.filename}</div><div style="font-size:11px;color:var(--text-muted);">${p.is_dir ? Lang.t('sv.dp.folder') : p.size_mb + ' Mo'}</div></div></div><button class="btn btn-sm btn-danger" onclick="ServerView._removeDatapack('${p.filename.replace(/'/g,"\\'")}')">${Lang.t('sv.mod.remove')}</button></div>`).join('');
 },

 async _removeDatapack(filename) {
 if (!confirm(`${Lang.t('sv.dp.remove_confirm')} "${filename}" ?`)) return;
 await Auth.apiCall(`/api/mods/datapacks/${this.serverId}/${encodeURIComponent(filename)}`, {method: 'DELETE'});
 this._loadInstalledDatapacks();
 },

 async _installMod(name, url, filename) {
 await Auth.apiCall('/api/mods/install',{method:'POST',body:JSON.stringify({server_id:this.serverId,mod_name:name,download_url:url,filename:filename})});
 },

 _pendingAction: null,

 async action(act) {
 this._pendingAction = act;
 this._updateHeaderStatus();

 if (act === 'start') await Auth.apiCall(`/api/servers/${this.serverId}/start`, { method: 'POST' });
 else if (act === 'stop') await Auth.apiCall(`/api/servers/${this.serverId}/stop`, { method: 'POST' });
 else if (act === 'restart') await Auth.apiCall(`/api/servers/${this.serverId}/restart`, { method: 'POST' });

 // Poll jusqu'au vrai statut (ready=true pour start/restart)
 const targetState = (act === 'stop') ? 'exited' : 'running';
 const initialDelay = (act === 'start' || act === 'restart') ? 5000 : 2000;
 let attempts = 0;
 setTimeout(() =>{
 const poll = setInterval(async () =>{
 attempts++;
 await this.refreshServer();
 const s = this.serverData;
 let isReady;
 if (targetState === 'exited') {
 isReady = s?.status !== 'running';
 } else {
 isReady = s?.status === 'running' && s?.ready === true;
 }
 if (isReady || attempts >= 40) {
 clearInterval(poll);
 this._pendingAction = null;
 this.render();
 if (isReady && typeof Toast !== 'undefined') {
 const labels = { start: Lang.t('sv.dash.started'), stop: Lang.t('sv.dash.stopped'), restart: Lang.t('sv.dash.restarted') };
 Toast.success(labels[act] || 'OK');
 } else if (attempts >= 40 && typeof Toast !== 'undefined') {
 Toast.error(Lang.t('sv.dash.timeout'));
 }
 } else {
 this._updateHeaderStatus();
 }
 }, 3000);
 }, initialDelay);
 },

 _updateHeaderStatus() {
 // Mise à jour sidebar
 const statusEl = document.querySelector('#sv-sidebar .sv-status-text');
 const btnContainer = document.querySelector('#sv-sidebar .sv-action-btns');
 if (statusEl) {
 const labels = { start: Lang.t('sv.starting'), stop: Lang.t('sv.stopping'), restart: Lang.t('sv.restarting') };
 statusEl.innerHTML = ` ${labels[this._pendingAction] || '…'}`;
 statusEl.style.color = 'var(--warning)';
 }
 if (btnContainer) {
 btnContainer.innerHTML = `<button class="btn btn-sm btn-secondary" disabled style="opacity:0.5;width:100%;">${Lang.t('sv.wait')}</button>`;
 }
 // Mise à jour du dashboard si visible
 if (this.currentTab === 'dashboard') {
 const dashContent = document.getElementById('sv-content');
 if (dashContent) {
 dashContent.innerHTML = this._dashboardTab();
 }
 }
 },

 _deleteServerPrompt() {
 const s = this.serverData;
 if (!s) return;
 const content = document.getElementById('sv-content');
 if (!content) return;

 content.innerHTML = `
 <div style="max-width:500px;margin:40px auto;"><div style="text-align:center;margin-bottom:24px;"><div style="font-size:48px;margin-bottom:12px;"></div><h2 style="color:var(--danger);margin:0;">${Lang.t('sv.delete_title')}</h2><p style="color:var(--text-muted);margin-top:8px;font-size:13px;">
 ${Lang.t('sv.delete_warning')}
 </p></div><div style="background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.3);border-radius:10px;padding:20px;"><p style="font-size:13px;color:var(--text);margin-bottom:12px;">
 ${Lang.t('sv.delete_confirm_text')} <strong style="color:var(--danger);">${s.name}</strong></p><input id="sv-delete-input" class="form-input" placeholder="Nom du serveur..." style="border-color:rgba(248,113,113,0.3);margin-bottom:12px;" autocomplete="off" /><div style="display:flex;gap:8px;"><button class="btn" style="background:var(--danger);color:white;flex:1;" onclick="ServerView._confirmDeleteServer()">
 ${Lang.t('sv.delete_btn')}
 </button><button class="btn btn-secondary" onclick="ServerView.switchTab('dashboard')">
 ${Lang.t('gs.cancel')}
 </button></div><div id="sv-delete-msg" style="font-size:13px;margin-top:10px;"></div></div></div>`;

 setTimeout(() =>document.getElementById('sv-delete-input')?.focus(), 100);
 },

 async _confirmDeleteServer() {
 const s = this.serverData;
 if (!s) return;
 const input = document.getElementById('sv-delete-input')?.value?.trim();
 const msg = document.getElementById('sv-delete-msg');

 if (input !== s.name) {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = Lang.t('sv.delete_name_mismatch'); }
 return;
 }

 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.deleting'); }

 const r = await Auth.apiCall(`/api/servers/${this.serverId}`, { method: 'DELETE' });
 if (r && r.ok) {
 if (typeof Toast !== 'undefined') Toast.success(`Serveur '${s.name}' supprimé`);
 App.navigateTo('game_server');
 } else {
 const err = r ? await r.json().catch(() =>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 },

 _bindEvents() {
 if (this.currentTab === 'version') this._initVersionListeners();
 },

 close() {
 if (this._ws) { this._ws.close(); this._ws = null; }
 this.serverId = null;
 this.serverData = null;
 },

 // --- Base de données MySQL ---
 _databaseTab() {
 setTimeout(() =>this._loadDatabase(), 50);
 return `
 <h2>${Lang.t('sv.db.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.db.desc')}</p><div id="sv-db-content"><div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('common.loading')}</div></div>`;
 },

 async _loadDatabase() {
 const el = document.getElementById('sv-db-content');
 if (!el) return;

 const r = await Auth.apiCall(`/api/servers/${this.serverId}/database`);
 if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger);">${Lang.t('common.error')}</div>`; return; }
 const data = await r.json();

 if (!data.exists) {
 // Formulaire de création
 el.innerHTML = `
 <div style="background:rgba(192,132,252,0.1);padding:20px;border-radius:10px;margin-bottom:16px;border:1px solid rgba(192,132,252,0.2);"><div style="font-size:14px;font-weight:600;margin-bottom:8px;">${Lang.t('sv.db.no_db')}</div><div style="font-size:13px;color:var(--text-muted);">${Lang.t('sv.db.no_db_desc')}</div></div><div class="card"><h3 style="margin:0 0 16px;">${Lang.t('sv.db.create')}</h3><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div><label class="form-label">${Lang.t('sv.db.name')}</label><input id="sv-db-name" class="form-input" value="minecraft" /></div><div><label class="form-label">${Lang.t('sv.db.user')}</label><input id="sv-db-user" class="form-input" value="mc_user" /></div><div><label class="form-label">${Lang.t('sv.db.password')}</label><input id="sv-db-pass" class="form-input" type="password" value="mc_pass" /></div><div><label class="form-label">${Lang.t('sv.db.root_pass')}</label><input id="sv-db-root" class="form-input" type="password" value="root_pass" /></div></div><div style="margin-top:16px;display:flex;align-items:center;gap:12px;"><button class="btn btn-primary" onclick="ServerView._createDB()">${Lang.t('sv.db.create_btn')}</button></div></div>`;
 } else {
 // Affichage statut
 const isRunning = data.status === 'running';
 el.innerHTML = `
 <div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;"><div><div style="font-size:16px;font-weight:700;">MariaDB</div><div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${data.container_name}</div></div><span class="status-badge ${isRunning ? 'online' : 'offline'}">
 ${isRunning ? Lang.t('gs.online') : Lang.t('gs.offline')}
 </span></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div style="background:var(--bg-elev-1);padding:12px;border-radius:8px;"><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.db.host')}</div><div style="font-family:monospace;font-size:14px;font-weight:600;margin-top:4px;">${data.host}</div></div><div style="background:var(--bg-elev-1);padding:12px;border-radius:8px;"><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.db.port')}</div><div style="font-family:monospace;font-size:14px;font-weight:600;margin-top:4px;">${data.port}</div></div></div><div style="margin-top:16px;display:flex;gap:8px;align-items:center;"><button class="btn btn-danger btn-sm" onclick="ServerView._confirmDeleteDB()">${Lang.t('sv.db.delete')}</button></div><div id="sv-db-del-confirm" style="display:none;background:rgba(248,113,113,0.1);border:2px solid var(--danger);border-radius:8px;padding:12px;margin-top:8px;"><div style="font-size:13px;color:var(--danger);font-weight:600;margin-bottom:8px;">${Lang.t('sv.db.delete_confirm')}</div><div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('sv.db.delete_warn')}</div><div style="display:flex;gap:8px;"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('sv-db-del-confirm').style.display='none'">${Lang.t('common.cancel')}</button><button class="btn btn-sm" style="background:var(--danger);color:white;" onclick="ServerView._deleteDB()">${Lang.t('sv.db.delete_yes')}</button></div></div></div><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;"><div style="font-size:13px;color:var(--text-muted);"><strong>${Lang.t('sv.db.plugin_hint')}</strong><br><code style="font-size:12px;color:var(--info);">address: ${data.host}:${data.port}</code></div></div>`;
 }
 },

 async _createDB() {
 const msg = document.getElementById('sv-db-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.db.creating'); }
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/database`, {
 method: 'POST',
 body: JSON.stringify({
 db_name: document.getElementById('sv-db-name')?.value || 'minecraft',
 db_user: document.getElementById('sv-db-user')?.value || 'mc_user',
 db_password: document.getElementById('sv-db-pass')?.value || 'mc_pass',
 root_password: document.getElementById('sv-db-root')?.value || 'root_pass',
 })
 });
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.db.created'); }
 setTimeout(() =>this._loadDatabase(), 1500);
 } else {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
 }
 },

 _confirmDeleteDB() {
 document.getElementById('sv-db-del-confirm').style.display = 'block';
 },

 async _deleteDB() {
 const msg = document.getElementById('sv-db-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.db.deleting'); }
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/database`, { method: 'DELETE' });
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.db.deleted'); }
 setTimeout(() =>this._loadDatabase(), 1500);
 } else {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
 }
 },

 // --- Gestion des mondes ---
 _worldsTab() {
 setTimeout(() =>this._loadWorlds(), 50);
 return `
 <h2>${Lang.t('sv.worlds.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.worlds.desc')}</p><div id="sv-worlds-content"><div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('common.loading')}</div></div>`;
 },

 async _loadWorlds() {
 const el = document.getElementById('sv-worlds-content');
 if (!el) return;

 const r = await Auth.apiCall(`/api/servers/${this.serverId}/worlds`);
 if (!r || !r.ok) {
 el.innerHTML = `<div style="color:var(--danger);padding:20px;">${Lang.t('sv.worlds.cant_load')}</div>`;
 return;
 }

 const data = await r.json();
 const worlds = data.worlds || [];
 const seed = data.seed || `(${Lang.t('sv.worlds.random')})`;

 const worldIcons = {
 'world': 'Overworld',
 'world_nether': 'Nether',
 'world_the_end': ' End',
 };

 el.innerHTML = `
 <!-- Seed --><div style="background:var(--accent-dim);padding:16px;border-radius:10px;margin-bottom:16px;border:1px solid rgba(74,222,128,0.2);"><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">${Lang.t('sv.worlds.seed')}</div><div style="font-family:monospace;font-size:16px;font-weight:600;color:var(--accent);">${seed || Lang.t('sv.worlds.random')}</div></div><!-- Liste des mondes --><div style="font-weight:600;margin-bottom:12px;">${Lang.t('sv.worlds.count')} (${worlds.length})</div>
 ${worlds.length === 0 ? `
 <div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;color:var(--text-muted);text-align:center;">
 ${Lang.t('sv.worlds.none')}
 </div>
 ` : worlds.map(w =>{
 const label = worldIcons[w.name] || ` ${w.name}`;
 return `
 <div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;"><div><div style="font-size:14px;font-weight:600;">${label}</div><div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${Lang.t('sv.worlds.folder')}: ${w.name}/ · ${Lang.t('sv.worlds.size')}: ${w.size}</div></div><div style="display:flex;gap:6px;align-items:center;"><button class="btn btn-secondary btn-sm" onclick="ServerView._confirmResetWorld('${w.name}')" style="font-size:12px;">${Lang.t('sv.worlds.reset')}</button></div></div><div id="sv-w-confirm-${w.name}" style="display:none;background:rgba(248,113,113,0.1);border:2px solid var(--danger);border-radius:10px;padding:12px;margin-bottom:8px;"><div style="font-size:13px;color:var(--danger);font-weight:600;margin-bottom:8px;">${Lang.t('sv.worlds.reset_confirm')} "${label}" ?</div><div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('sv.worlds.reset_warn')}</div><div style="display:flex;gap:8px;"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('sv-w-confirm-${w.name}').style.display='none'">${Lang.t('common.cancel')}</button><button class="btn btn-sm" style="background:var(--danger);color:white;" onclick="ServerView._resetWorld('${w.name}')">${Lang.t('sv.worlds.reset_yes')}</button></div></div>`;
 }).join('')}

 <div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;margin-top:16px;"><div style="font-size:13px;color:var(--text-muted);"><strong>${Lang.t('sv.worlds.tip')}</strong></div></div>`;
 },

 _confirmResetWorld(name) {
 document.getElementById(`sv-w-confirm-${name}`).style.display = 'block';
 },

 async _resetWorld(name) {
 document.getElementById(`sv-w-confirm-${name}`).style.display = 'none';
 const msg = document.getElementById(`sv-w-msg-${name}`);
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = '…'; }

 const r = await Auth.apiCall(`/api/servers/${this.serverId}/worlds/${name}`, { method: 'DELETE' });
 if (r && r.ok) {
 const data = await r.json();
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = `${Lang.t('sv.db.deleted')}`; }
 setTimeout(() =>this._loadWorlds(), 1500);
 } else {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
 }
 },

 // --- Version / Type de serveur ---
 _versionTab() {
 const s = this.serverData;
 const currentType = (s.server_type || 'VANILLA').toUpperCase();
 const isMinecraft = s.game_type === 'minecraft';

 const types = [
 {id:'VANILLA', name:'Vanilla', desc:Lang.t('sv.type.vanilla')},
 {id:'PAPER', name:'Paper', desc:Lang.t('sv.type.paper')},
 {id:'SPIGOT', name:'Spigot', desc:Lang.t('sv.type.spigot')},
 {id:'BUKKIT', name:'Bukkit', desc:Lang.t('sv.type.bukkit')},
 {id:'PURPUR', name:'Purpur', desc:Lang.t('sv.type.purpur')},
 {id:'FORGE', name:'Forge', desc:Lang.t('sv.type.forge')},
 {id:'NEOFORGE', name:'NeoForge', desc:Lang.t('sv.type.neoforge')},
 {id:'FABRIC', name:'Fabric', desc:Lang.t('sv.type.fabric')},
 {id:'QUILT', name:'Quilt', desc:Lang.t('sv.type.quilt')},
 {id:'MOHIST', name:'Mohist', desc:Lang.t('sv.type.mohist')},
 {id:'CATSERVER', name:'CatServer', desc:Lang.t('sv.type.catserver')},
 {id:'PUFFERFISH', name:'Pufferfish', desc:Lang.t('sv.type.pufferfish')},
 ];

 if (!isMinecraft) {
 return `
 <h2>${Lang.t('sv.ver.version')}</h2><p style="color:var(--text-muted);font-size:13px;">${Lang.t('sv.ver.only_mc')}</p><div style="background:var(--bg-elev-1);padding:16px;border-radius:10px;margin-top:16px;"><div style="font-size:14px;">${Lang.t('sv.ver.game')} : <strong>${s.game_type}</strong></div><div style="font-size:14px;margin-top:4px;">${Lang.t('sv.ver.version')} : <strong>${s.version || 'LATEST'}</strong></div></div>`;
 }

 const current = types.find(t =>t.id === currentType) || types[0];

 const versionOptions = [
 'LATEST','1.21.4','1.21.3','1.21.2','1.21.1','1.21',
 '1.20.6','1.20.4','1.20.2','1.20.1',
 '1.19.4','1.19.2','1.18.2','1.17.1','1.16.5',
 '1.15.2','1.14.4','1.13.2','1.12.2','1.12',
 '1.11.2','1.10.2','1.9.4','1.8.9','1.8.8','1.7.10'
 ];

 const currentVer = s.version || 'LATEST';
 const isKnownVersion = versionOptions.includes(currentVer);

 return `
 <h2>${Lang.t('sv.ver.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.ver.desc')}</p><!-- Version actuelle --><div style="background:rgba(96,165,250,0.15);padding:20px;border-radius:12px;margin-bottom:20px;border:1px solid rgba(96,165,250,0.3);"><div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${Lang.t('sv.ver.current')}</div><div style="display:flex;align-items:center;gap:14px;"><span class="b-ticker">${(current.id||'?').slice(0,3).toUpperCase()}</span><div><div style="font-size:20px;font-weight:700;">${current.name}</div><div style="font-size:14px;color:var(--text-muted);">Minecraft ${currentVer}</div></div></div></div><!-- Sélection du type --><div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="font-weight:600;margin-bottom:10px;">${Lang.t('sv.ver.server_type')}</div><select id="sv-ver-type" class="form-input" style="font-size:14px;">
 ${types.map(t =>`<option value="${t.id}" ${t.id === currentType ? 'selected' : ''}>${t.name} — ${t.desc}</option>`).join('')}
 </select></div><!-- Version Minecraft --><div id="sv-ver-version-group" style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="font-weight:600;margin-bottom:10px;">${Lang.t('sv.ver.mc_version')}</div><select id="sv-ver-version" class="form-input" style="font-size:14px;" onchange="document.getElementById('sv-ver-version-custom').style.display=this.value==='CUSTOM'?'block':'none'"><option value="LATEST" ${currentVer === 'LATEST' ? 'selected' : ''}>${Lang.t('sv.ver.latest')}</option>
 ${versionOptions.filter(v =>v !== 'LATEST').map(v =>`<option value="${v}" ${v === currentVer ? 'selected' : ''}>${v}</option>`).join('')}
 <option value="CUSTOM" ${!isKnownVersion && currentVer !== 'LATEST' ? 'selected' : ''}>${Lang.t('sv.ver.custom')}</option></select><input id="sv-ver-version-custom" class="form-input" value="${!isKnownVersion && currentVer !== 'LATEST' ? currentVer : ''}" placeholder="Ex: 1.12.2, 23w13a (snapshot)..." style="display:${!isKnownVersion && currentVer !== 'LATEST' ? 'block' : 'none'};margin-top:8px;" /></div><!-- Modpack CurseForge (affiché pour Forge/Fabric/NeoForge/Quilt) --><div id="sv-ver-modpack-group" style="display:${['FORGE','NEOFORGE','FABRIC','QUILT'].includes(currentType) ? 'block' : 'none'};"><div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="font-weight:600;margin-bottom:10px;">${Lang.t('sv.ver.content_mode')}</div><div style="display:flex;gap:8px;margin-bottom:12px;"><button type="button" id="sv-ver-mp-blank" class="btn btn-primary btn-sm" onclick="ServerView._setVerModpackMode('blank')" style="flex:1;padding:10px;">
 ${Lang.t('sv.ver.blank')}<br><span style="font-size:10px;font-weight:400;opacity:0.8;">${Lang.t('sv.ver.blank_desc')}</span></button><button type="button" id="sv-ver-mp-modpack" class="btn btn-secondary btn-sm" onclick="ServerView._setVerModpackMode('modpack')" style="flex:1;padding:10px;">
 Modpack CurseForge<br><span style="font-size:10px;font-weight:400;opacity:0.8;">${Lang.t('sv.ver.modpack_desc')}</span></button></div><div id="sv-ver-mp-search" style="display:none;"><div style="display:flex;gap:6px;margin-bottom:8px;"><input id="sv-ver-mp-q" class="form-input" placeholder="${Lang.t('sv.ver.search_modpack')}" style="flex:1;" onkeydown="if(event.key==='Enter')ServerView._searchVerModpacks()" /><button class="btn btn-primary btn-sm" onclick="ServerView._searchVerModpacks()"></button></div><div id="sv-ver-mp-results" style="max-height:180px;overflow-y:auto;"></div><div id="sv-ver-mp-selected" style="display:none;background:var(--accent-dim);border:1px solid rgba(74,222,128,0.3);border-radius:8px;padding:10px;margin-top:8px;"></div></div></div></div><!-- Option réinstallation --><div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="font-weight:600;margin-bottom:10px;">${Lang.t('sv.ver.install_mode')}</div><label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;border-radius:8px;border:2px solid var(--accent);background:rgba(74,222,128,0.08);margin-bottom:8px;"><input type="radio" name="sv-ver-mode" value="keep" checked /><div><div style="font-size:13px;font-weight:600;">${Lang.t('sv.ver.keep_files')}</div><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.ver.keep_desc')}</div></div></label><label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;border-radius:8px;border:2px solid var(--border);"><input type="radio" name="sv-ver-mode" value="reset" /><div><div style="font-size:13px;font-weight:600;color:var(--danger);">${Lang.t('sv.ver.reset_all')}</div><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.ver.reset_desc')}</div></div></label></div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;"><button id="sv-ver-apply-btn" class="btn btn-primary" onclick="ServerView._changeVersion()" style="padding:10px 24px;font-size:14px;">${Lang.t('sv.ver.apply')}</button></div><div id="sv-ver-confirm" style="display:none;margin-top:12px;background:rgba(248,113,113,0.1);border:2px solid var(--danger);border-radius:10px;padding:16px;"><div style="font-weight:600;color:var(--danger);margin-bottom:8px;">${Lang.t('sv.ver.confirm_reset')}</div><div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">${Lang.t('sv.ver.confirm_reset_desc')}</div><div style="display:flex;gap:8px;"><button class="btn btn-secondary" onclick="document.getElementById('sv-ver-confirm').style.display='none';document.getElementById('sv-ver-apply-btn').style.display='';">${Lang.t('common.cancel')}</button><button class="btn" style="background:var(--danger);color:white;" onclick="ServerView._changeVersionConfirmed()">${Lang.t('sv.ver.confirm_reset_yes')}</button></div></div>`;
 },

 _changeVersionPending: null,
 _verPageUrl: null,
 _verFileId: null,

 _initVersionListeners() {
 const typeSelect = document.getElementById('sv-ver-type');
 if (typeSelect) {
 typeSelect.addEventListener('change', () =>{
 const moddable = ['FORGE','NEOFORGE','FABRIC','QUILT'];
 const group = document.getElementById('sv-ver-modpack-group');
 if (group) group.style.display = moddable.includes(typeSelect.value) ? 'block' : 'none';
 if (!moddable.includes(typeSelect.value)) {
 this._verPageUrl = null;
 this._verFileId = null;
 }
 });
 }
 },

 _setVerModpackMode(mode) {
 const blankBtn = document.getElementById('sv-ver-mp-blank');
 const modpackBtn = document.getElementById('sv-ver-mp-modpack');
 const searchArea = document.getElementById('sv-ver-mp-search');
 const selectedArea = document.getElementById('sv-ver-mp-selected');

 if (blankBtn) blankBtn.className = mode === 'blank' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
 if (modpackBtn) modpackBtn.className = mode === 'modpack' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
 if (searchArea) searchArea.style.display = mode === 'modpack' ? 'block' : 'none';
 if (selectedArea && mode === 'blank') {
 selectedArea.style.display = 'none';
 this._verPageUrl = null;
 this._verFileId = null;
 }
 // Réafficher le dropdown de version normal si on revient en vierge
 const vg = document.getElementById('sv-ver-version-group');
 if (vg) vg.style.display = mode === 'blank' ? 'block' : (this._verPageUrl ? 'none' : 'block');
 },

 async _searchVerModpacks() {
 const q = document.getElementById('sv-ver-mp-q')?.value?.trim();
 if (!q) return;
 const el = document.getElementById('sv-ver-mp-results');
 if (!el) return;
 el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px;">${Lang.t('common.loading')}</div>`;

 const r = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(q)}&category=modpacks`);
 if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger);font-size:12px;">${Lang.t('common.error')}</div>`; return; }
 const data = await r.json();
 const mods = data.mods || [];
 if (mods.length === 0) { el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">${Lang.t('sv.mod.no_results')}</div>`; return; }

 el.innerHTML = mods.map(m =>{
 const dl = m.downloads >1000000 ? `${(m.downloads/1000000).toFixed(1)}M` : m.downloads >1000 ? `${Math.round(m.downloads/1000)}k` : m.downloads;
 const safeUrl = (m.url||'').replace(/'/g,"\\'");
 const safeName = (m.name||'').replace(/'/g,"\\'");
 return `
 <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;cursor:pointer;transition:all .15s;" onmouseover="this.style.background='var(--bg-elev-2)'" onmouseout="this.style.background='var(--bg-elev-1)'" onclick="ServerView._selectVerModpack(${m.id}, '${safeName}', '${m.icon_url||''}', '${safeUrl}')"><img src="${m.icon_url||''}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;" onerror="this.style.display='none'" /><div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.name}</div><div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.summary||''}</div></div><span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${dl}</span></div>`;
 }).join('');
 },

 async _selectVerModpack(id, name, iconUrl, pageUrl) {
 this._verPageUrl = pageUrl;
 this._verFileId = null;
 const el = document.getElementById('sv-ver-mp-selected');
 const results = document.getElementById('sv-ver-mp-results');
 if (results) results.innerHTML = '';
 if (!el) return;

 // Cacher le dropdown de version normal (le modpack dicte la version)
 const vg = document.getElementById('sv-ver-version-group');
 if (vg) vg.style.display = 'none';

 el.style.display = 'block';
 el.innerHTML = `
 <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;"><img src="${iconUrl}" style="width:36px;height:36px;border-radius:8px;" onerror="this.style.display='none'" /><div style="flex:1;"><div style="font-size:14px;font-weight:700;">${name}</div><div style="font-size:10px;color:var(--text-muted);">${Lang.t('common.loading')}</div></div><button class="btn btn-secondary btn-sm" onclick="ServerView._clearVerModpack()" style="font-size:10px;"></button></div><div id="sv-ver-mp-versions"><div style="color:var(--text-muted);font-size:12px;">${Lang.t('common.loading')}</div></div>`;

 // Charger les fichiers du modpack
 const r = await Auth.apiCall(`/api/mods/${id}/files`);
 if (!r || !r.ok) {
 document.getElementById('sv-ver-mp-versions').innerHTML = `<div style="color:var(--danger);">${Lang.t('common.error')}</div>`;
 return;
 }
 const files = (await r.json()).files || [];
 if (files.length === 0) {
 document.getElementById('sv-ver-mp-versions').innerHTML = `<div style="color:var(--text-muted);">${Lang.t('sv.ver.no_versions')}</div>`;
 return;
 }

 const versEl = document.getElementById('sv-ver-mp-versions');
 if (!versEl) return;
 versEl.innerHTML = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${files.length} ${Lang.t('sv.ver.versions_available')}</div>` +
 files.map(f =>{
 const mcVers = (f.game_versions||[]).filter(v =>/^\d/.test(v)).join(', ') || '?';
 const type = f.release_type || '';
 const typeColor = type === 'Release' ? 'var(--accent)' : type === 'Beta' ? 'var(--warning)' : 'var(--text-muted)';
 const safeName2 = (f.name||'').replace(/'/g,"\\'");
 return `
 <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elev-3);border-radius:6px;margin-bottom:3px;cursor:pointer;transition:all .15s;" onmouseover="this.style.background='var(--bg-elev-2)'" onmouseout="this.style.background='var(--bg-elev-3)'" onclick="ServerView._pickVerModpackFile(${f.id}, '${safeName2}', '${mcVers}')"><div style="flex:1;"><div style="font-size:12px;font-weight:600;">${f.name}</div><div style="font-size:10px;color:var(--text-muted);">MC ${mcVers} · ${f.size_mb} Mo · <span style="color:${typeColor};">${type}</span></div></div></div>`;
 }).join('');
 },

 _pickVerModpackFile(fileId, fileName, mcVersion) {
 this._verFileId = fileId;
 // Mettre à jour le dropdown de version MC (caché) avec la bonne version
 const verSelect = document.getElementById('sv-ver-version');
 if (verSelect) verSelect.value = mcVersion.split(',')[0]?.trim() || 'LATEST';

 const versEl = document.getElementById('sv-ver-mp-versions');
 if (versEl) {
 versEl.innerHTML = `
 <div style="background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:6px;padding:10px;display:flex;align-items:center;gap:8px;"><div><div style="font-size:13px;font-weight:600;color:var(--accent);">${fileName}</div><div style="font-size:10px;color:var(--text-muted);">Minecraft ${mcVersion} — ${Lang.t('sv.ver.will_install')}</div></div><button class="btn btn-secondary btn-sm" onclick="ServerView._selectVerModpack(0,'','','${this._verPageUrl}')" style="font-size:9px;margin-left:auto;">${Lang.t('sv.ver.change')}</button></div>`;
 }
 },

 _clearVerModpack() {
 this._verPageUrl = null;
 this._verFileId = null;
 const el = document.getElementById('sv-ver-mp-selected');
 if (el) el.style.display = 'none';
 const vg = document.getElementById('sv-ver-version-group');
 if (vg) vg.style.display = 'block';
 },

 async _changeVersion() {
 const msg = document.getElementById('sv-ver-msg');
 const selectedType = document.getElementById('sv-ver-type')?.value || 'VANILLA';
 let version = document.getElementById('sv-ver-version')?.value || 'LATEST';
 if (version === 'CUSTOM') {
 version = document.getElementById('sv-ver-version-custom')?.value?.trim() || '';
 if (!version) {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = Lang.t('sv.ver.enter_custom'); }
 return;
 }
 }
 const resetData = document.querySelector('[name=sv-ver-mode]:checked')?.value === 'reset';

 if (resetData) {
 this._changeVersionPending = { selectedType, version, resetData: true };
 document.getElementById('sv-ver-confirm').style.display = 'block';
 document.getElementById('sv-ver-apply-btn').style.display = 'none';
 return;
 }
 await this._doChangeVersion(selectedType, version, false);
 },

 async _changeVersionConfirmed() {
 if (!this._changeVersionPending) return;
 const { selectedType, version } = this._changeVersionPending;
 this._changeVersionPending = null;
 document.getElementById('sv-ver-confirm').style.display = 'none';
 document.getElementById('sv-ver-apply-btn').style.display = '';
 await this._doChangeVersion(selectedType, version, true);
 },

 async _doChangeVersion(selectedType, version, resetData) {
 const msg = document.getElementById('sv-ver-msg');
 const hasModpack = !!this._verPageUrl;
 if (msg) {
 msg.style.color = 'var(--info)';
 msg.textContent = hasModpack
 ? Lang.t('sv.ver.applying_modpack')
 : Lang.t('sv.ver.applying');
 }

 const body = { server_type: selectedType, version, reset_data: resetData };
 if (this._verPageUrl) body.cf_page_url = this._verPageUrl;
 if (this._verFileId) body.cf_file_id = this._verFileId;

 const r = await Auth.apiCall(`/api/servers/${this.serverId}/version`, {
 method: 'PUT',
 body: JSON.stringify(body)
 });

 if (r && r.ok) {
 const data = await r.json();
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = `${data.message}`; }
 this._verPageUrl = null;
 this._verFileId = null;
 await this.refreshServer();
 setTimeout(() =>this.switchTab('version'), 1000);
 } else {
 const err = r ? await r.json().catch(() =>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 },

 // --- Dashboard live stats ---
 async _loadDashboardStats() {
 const el = document.getElementById('sv-dash-docker');
 if (!el) return;
 
 // Load mini-logs too (only if canManage)
 const al = this.serverData?.access_level || 'view_only';
 const canManage = al === 'owner' || al === 'manage';
 if (canManage) this._refreshDashLogs();

 // Resolve actual version if "LATEST"
 if (this.serverData?.version === 'LATEST' && !this._resolvedVersion) {
 this._resolveLatestVersion();
 }
 
 try {
 const r = await Auth.apiCall(`/api/containers/${this.serverData?.docker_id}/stats`);
 if (r && r.ok) {
 const stats = await r.json();
 el.innerHTML = `
 <div style="font-size:13px;font-weight:600;margin-bottom:10px;">${Lang.t('sv.dash.docker')}</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;"><div><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.dash.cpu_used')}</div><div style="font-size:18px;font-weight:700;color:var(--info);">${(stats.cpu_percent||0).toFixed(1)}%</div><div style="background:var(--bg-elev-3);height:4px;border-radius:2px;margin-top:4px;"><div style="background:var(--info);height:100%;border-radius:2px;width:${Math.min(stats.cpu_percent||0,100)}%;"></div></div></div><div><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.dash.ram_used')}</div><div style="font-size:18px;font-weight:700;color:var(--accent);">${stats.memory_mb ? stats.memory_mb.toFixed(0) : '?'} Mo</div><div style="background:var(--bg-elev-3);height:4px;border-radius:2px;margin-top:4px;"><div style="background:var(--accent);height:100%;border-radius:2px;width:${stats.memory_percent ? Math.min(stats.memory_percent,100) : 0}%;"></div></div></div><div><div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.dash.network')}</div><div style="font-size:14px;font-weight:600;">↑ ${stats.net_tx_mb ? stats.net_tx_mb.toFixed(1) : '0'} Mo</div><div style="font-size:14px;font-weight:600;">↓ ${stats.net_rx_mb ? stats.net_rx_mb.toFixed(1) : '0'} Mo</div></div></div>`;
 } else {
 el.innerHTML = `
 <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Docker</div><div style="color:var(--text-muted);font-size:12px;">${Lang.t('sv.dash.docker_offline')}</div>`;
 }
 } catch (e) {
 el.innerHTML = `
 <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Docker</div><div style="color:var(--text-muted);font-size:12px;">${Lang.t('sv.dash.docker_offline')}</div>`;
 }
 },

 async _resolveLatestVersion() {
 try {
 // Try to get version from server logs or properties
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/logs?tail=50`);
 if (r && r.ok) {
 const data = await r.json();
 const logs = data.logs || '';
 // Look for version pattern in Minecraft logs: "Starting minecraft server version X.Y.Z"
 const match = logs.match(/version\s+(\d+\.\d+(?:\.\d+)?)/i);
 if (match) {
 this._resolvedVersion = match[1];
 // Update the version display
 const verEl = document.querySelector('[data-version-display]');
 if (verEl) verEl.textContent = `${this.serverData?.server_type || 'VANILLA'} · v${this._resolvedVersion}`;
 return;
 }
 }
 // Fallback: try Minecraft version API
 const mcr = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
 if (mcr.ok) {
 const manifest = await mcr.json();
 const release = manifest.latest?.release;
 if (release) {
 this._resolvedVersion = release;
 const verEl = document.querySelector('[data-version-display]');
 if (verEl) verEl.textContent = `${this.serverData?.server_type || 'VANILLA'} · v${this._resolvedVersion}`;
 }
 }
 } catch(e) { /* silent */ }
 },

 async _refreshDashLogs() {
 const el = document.getElementById('sv-dash-logs');
 const timeEl = document.getElementById('sv-dash-logs-time');
 if (!el) return;
 
 try {
 const r = await Auth.apiCall(`/api/servers/${this.serverId}/logs?tail=15`);
 if (!r || !r.ok) {
 el.textContent = Lang.t('sv.dash.docker_offline');
 el.style.color = 'var(--text-muted)';
 return;
 }
 const data = await r.json();
 const logs = data.logs || '';
 
 if (!logs.trim()) {
 el.textContent = Lang.t('sv.dash.docker_offline');
 el.style.color = 'var(--text-muted)';
 return;
 }
 
 // Color-code each line
 el.innerHTML = '';
 logs.split('\n').forEach(line =>{
 if (!line.trim()) return;
 const span = document.createElement('span');
 const t = line.toLowerCase();
 let color = '#c9d1d9';
 if (t.includes('error') || t.includes('exception') || t.includes('severe')) color = 'var(--danger)';
 else if (t.includes('warn')) color = 'var(--warning)';
 else if (t.includes('joined') || t.includes('logged in')) color = 'var(--accent)';
 else if (t.includes('starting') || t.includes('done (') || t.includes('preparing')) color = 'var(--violet)';
 else if (t.includes('info')) color = '#8b949e';
 span.style.color = color;
 span.textContent = line + '\n';
 el.appendChild(span);
 });
 el.scrollTop = el.scrollHeight;
 
 if (timeEl) timeEl.textContent = new Date().toLocaleTimeString(Lang.t('common.locale') || 'fr-FR');
 } catch (e) {
 el.textContent = Lang.t('sv.dash.docker_offline');
 el.style.color = 'var(--text-muted)';
 }
 },

 // --- Notifications Discord ---
 _notificationsTab() {
 setTimeout(() =>this._loadNotifSettings(), 50);
 return `
 <h2>${Lang.t('sv.notif.title')}</h2><p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.notif.desc')}</p><div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="font-weight:600;margin-bottom:12px;">${Lang.t('sv.notif.webhook')}</div><div style="display:flex;gap:8px;align-items:center;"><input id="sv-notif-webhook" class="form-input" placeholder="https://discord.com/api/webhooks/..." style="flex:1;font-family:monospace;font-size:12px;" /></div><div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
 ${Lang.t('sv.notif.webhook_hint')}
 </div></div><div style="background:var(--bg-elev-1);padding:20px;border-radius:10px;margin-bottom:16px;"><div style="font-weight:600;margin-bottom:12px;">${Lang.t('sv.notif.events')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="checkbox" id="sv-notif-start" checked />${Lang.t('sv.notif.start')}
 </label><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="checkbox" id="sv-notif-stop" checked />${Lang.t('sv.notif.stop')}
 </label><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="checkbox" id="sv-notif-crash" checked />${Lang.t('sv.notif.crash')}
 </label><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="checkbox" id="sv-notif-backup" checked />${Lang.t('sv.notif.backup')}
 </label><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="checkbox" id="sv-notif-join" />${Lang.t('sv.notif.join')}
 </label><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="checkbox" id="sv-notif-leave" />${Lang.t('sv.notif.leave')}
 </label></div></div><div style="display:flex;gap:8px;align-items:center;"><button class="btn btn-primary" onclick="ServerView._saveNotifSettings()">${Lang.t('sv.notif.save')}</button><button class="btn btn-secondary" onclick="ServerView._testNotif()">${Lang.t('sv.notif.test')}</button></div>`;
 },

 async _loadNotifSettings() {
 const r = await Auth.apiCall('/api/notifications/settings');
 if (!r || !r.ok) return;
 const s = await r.json();

 const el = (id) =>document.getElementById(id);
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
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.notif.saved'); }
 } else {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
 }
 },

 async _testNotif() {
 const msg = document.getElementById('sv-notif-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.notif.testing'); }

 const r = await Auth.apiCall('/api/notifications/test', { method: 'POST' });
 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.notif.tested'); }
 } else {
 const err = r ? await r.json().catch(()=>({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 },
};
