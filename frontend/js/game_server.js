/**
 * GameServer.js — Interface du module Serveurs de jeux.
 * 
 * Supporte tous les jeux : Minecraft, ARK, Valheim, Terraria, CS2, etc.
 * Affiche l'IP de connexion et le port pour chaque serveur.
 */

const GameServer = {
 _statusInterval: null,
 _games: [], // Liste des jeux supportés
 _serverIP: '', // IP locale du serveur
 _consoleWS: null, // WebSocket de la console live

 /**
 * Charge et affiche la vue du module jeux.
 */
 async load() {
 // Charger la liste des jeux et l'IP en parallèle
 await Promise.all([
 this.loadGames(),
 this.loadConnectionInfo(),
 ]);
 this.renderView();
 await this.refreshServers();
 this.startStatusRefresh();
 },

 unload() {
 if (this._statusInterval) {
 clearInterval(this._statusInterval);
 this._statusInterval = null;
 }
 this.closeConsoleWS();
 },

 /**
 * Charge la liste des jeux supportés depuis l'API.
 */
 async loadGames() {
 const response = await Auth.apiCall('/api/servers/games');
 if (response) {
 const data = await response.json();
 this._games = data.games;
 }
 },

 /**
 * Récupère l'IP locale du serveur.
 */
 async loadConnectionInfo() {
 const response = await Auth.apiCall('/api/servers/connection-info');
 if (response) {
 const data = await response.json();
 this._serverIP = data.ip;
 }
 },

 /**
 * Génère le HTML de la vue module jeux.
 */
 renderView() {
 const content = document.getElementById('module-content');
 if (!content) return;

 // Générer les options du sélecteur de jeux
 const gameOptions = this._games.map(g => 
 `<option value="${g.id}" data-port="${g.default_port}" data-memory="${g.default_memory_mb}" data-icon="${g.icon}">
 ${g.icon} ${g.name}
 </option>`
 ).join('');

 content.innerHTML = `
 <div class="page-header flex justify-between items-center"><div><h1 class="page-title">${Lang.t('gs.title')}</h1><p class="page-subtitle">${Lang.t('gs.subtitle')} — ${this._games.length} ${Lang.t('gs.game_label')}</p></div><div class="flex gap-2">
 ${(() => {
 const u = Auth.getUser();
 const canCreate = u && (u.is_admin || u.role === 'moderator');
 return canCreate ? `<button class="btn btn-primary" onclick="GameServer.showCreateModal()">
 ${Lang.t('gs.create')}
 </button>` : '';
 })()}
 <button class="btn btn-secondary" onclick="App.navigateTo('hub')">
 ${Lang.t('gs.back_hub')}
 </button></div></div><div id="docker-warning" class="hidden" style="background: var(--warning); color: #000; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 13px;">
 ${Lang.t('gs.docker_warn')}
 </div><div id="server-list" class="server-list"><div class="text-center" style="padding: 40px; color: var(--text-muted);">
 ${Lang.t('common.loading')}
 </div></div><!-- Modal création --><div id="create-modal" class="modal-overlay"><div class="modal" style="max-width: 520px;"><h2 class="modal-title">${Lang.t('gs.new_server')}</h2><div class="form-group"><label class="form-label">${Lang.t('gs.game_label')}</label><select class="form-input" id="server-game-type" onchange="GameServer.onGameChange()">
 ${gameOptions}
 </select></div><div id="game-description" style="font-size: 12px; color: var(--text-muted); margin-top: -12px; margin-bottom: 16px;"></div><div class="form-group"><label class="form-label">${Lang.t('gs.server_name')}</label><input type="text" class="form-input" id="server-name" placeholder="Mon serveur" /></div><div class="form-group" id="server-type-group"><label class="form-label">${Lang.t('gs.server_type')}</label><select class="form-input" id="server-type-select"><option value="VANILLA">Vanilla</option><option value="PAPER" selected>Paper (recommandé)</option><option value="SPIGOT">Spigot</option><option value="BUKKIT">Bukkit</option><option value="PURPUR">Purpur</option><option value="FORGE">Forge</option><option value="NEOFORGE">NeoForge</option><option value="FABRIC">Fabric</option><option value="QUILT">Quilt</option><option value="MOHIST">Mohist</option><option value="CATSERVER">CatServer</option><option value="PUFFERFISH">Pufferfish</option></select></div><div class="form-group" id="version-group"><label class="form-label">${Lang.t('gs.version')}</label><select class="form-input" id="server-version"><option value="LATEST">Dernière version (LATEST)</option><option value="1.21.4">1.21.4</option><option value="1.21.3">1.21.3</option><option value="1.21.2">1.21.2</option><option value="1.21.1">1.21.1</option><option value="1.21">1.21</option><option value="1.20.6">1.20.6</option><option value="1.20.4">1.20.4</option><option value="1.20.2">1.20.2</option><option value="1.20.1">1.20.1</option><option value="1.19.4">1.19.4</option><option value="1.19.2">1.19.2</option><option value="1.18.2">1.18.2</option><option value="1.17.1">1.17.1</option><option value="1.16.5">1.16.5</option><option value="1.15.2">1.15.2</option><option value="1.14.4">1.14.4</option><option value="1.13.2">1.13.2</option><option value="1.12.2">1.12.2</option><option value="1.12">1.12</option><option value="1.11.2">1.11.2</option><option value="1.10.2">1.10.2</option><option value="1.9.4">1.9.4</option><option value="1.8.9">1.8.9</option><option value="1.8.8">1.8.8</option><option value="1.7.10">1.7.10</option><option value="CUSTOM">Version personnalisée...</option></select><input type="text" class="form-input" id="server-version-custom" placeholder="Ex: 1.12.2, 23w13a (snapshot)..." style="display:none;margin-top:8px;" /></div><!-- Choix modpack (affiché pour Forge/Fabric/NeoForge/Quilt) --><div id="modpack-choice-group" style="display:none;"><label class="form-label">${Lang.t('gs.install_mode')}</label><div style="display:flex;gap:8px;margin-bottom:12px;"><button type="button" id="modpack-mode-blank" class="btn btn-primary btn-sm" onclick="GameServer.setModpackMode('blank')" style="flex:1;padding:10px;">
 ${Lang.t('gs.blank_server')}<br><span style="font-size:10px;font-weight:400;opacity:0.8;">${Lang.t('gs.blank_hint')}</span></button><button type="button" id="modpack-mode-modpack" class="btn btn-secondary btn-sm" onclick="GameServer.setModpackMode('modpack')" style="flex:1;padding:10px;">
 ${Lang.t('gs.modpack_cf')}<br><span style="font-size:10px;font-weight:400;opacity:0.8;">${Lang.t('gs.modpack_hint')}</span></button></div><div id="modpack-search-area" style="display:none;"><div style="display:flex;gap:6px;margin-bottom:8px;"><input id="modpack-search-q" class="form-input" placeholder="${Lang.t('gs.search_modpack')}" style="flex:1;" onkeydown="if(event.key==='Enter')GameServer.searchModpacks()" /><button class="btn btn-primary btn-sm" onclick="GameServer.searchModpacks()">Search</button></div><div id="modpack-results" style="max-height:200px;overflow-y:auto;"></div><div id="modpack-selected" style="display:none;background:var(--accent-dim);border:1px solid rgba(74,222,128,0.3);border-radius:8px;padding:10px;margin-top:8px;"></div></div></div><div class="form-group" id="custom-image-group" style="display: none;"><label class="form-label">${Lang.t('gs.docker_image')}</label><input type="text" class="form-input" id="server-custom-image" placeholder="mon-image:latest" /></div><div style="display: flex; gap: 12px;"><input type="hidden" id="server-port" value="25565" /><div class="form-group" style="flex: 1;"><label class="form-label">${Lang.t('gs.ram')}</label><input type="number" class="form-input" id="server-memory" value="2" step="0.5" min="0.5" /></div></div><div id="create-error" class="login-error"></div><div id="create-loading" class="hidden" style="text-align: center; padding: 12px; color: var(--text-muted); font-size: 13px;">
 ${Lang.t('gs.creating')}
 </div><div id="create-buttons" class="flex gap-2 mt-4"><button class="btn btn-primary" onclick="GameServer.createServer()">${Lang.t('gs.create_btn')}</button><button class="btn btn-secondary" onclick="GameServer.hideCreateModal()">${Lang.t('gs.cancel')}</button></div></div></div><!-- Modal console live --><div id="logs-modal" class="modal-overlay"><div class="modal" style="max-width: 800px;"><div class="flex justify-between items-center mb-4"><div class="flex items-center gap-3"><h2 class="modal-title" style="margin: 0;">${Lang.t('gs.console_live')}</h2><span id="console-status" style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-elev-2); color: var(--text-muted);">${Lang.t('gs.disconnected')}</span></div><button class="btn btn-secondary btn-sm" onclick="GameServer.hideLogsModal()">${Lang.t('gs.close')}</button></div><div id="server-logs" class="console" style="height: 400px; overflow-y: auto; font-size: 12px; line-height: 1.6;">${Lang.t('gs.connecting')}</div><div style="display: flex; gap: 8px; margin-top: 8px;"><input type="text" class="form-input" id="console-command" placeholder="${Lang.t('gs.send_cmd')}" style="flex: 1; font-family: monospace; font-size: 13px;" onkeydown="if(event.key==='Enter') GameServer.sendCommand()" /><button class="btn btn-primary" onclick="GameServer.sendCommand()">${Lang.t('gs.send')}</button></div></div></div><!-- Modal sauvegardes --><div id="backups-modal" class="modal-overlay"><div class="modal" style="max-width: 650px;"><div class="flex justify-between items-center mb-4"><h2 class="modal-title" style="margin: 0;">${Lang.t('gs.backups_title')}</h2><div class="flex gap-2"><button class="btn btn-primary btn-sm" id="backup-create-btn" onclick="GameServer.createBackup()">
 ${Lang.t('gs.backup_now')}
 </button><button class="btn btn-secondary btn-sm" onclick="GameServer.hideBackupsModal()">${Lang.t('gs.close')}</button></div></div><div id="backups-list" style="max-height: 400px; overflow-y: auto;"><div style="text-align: center; padding: 30px; color: var(--text-muted);">${Lang.t('common.loading')}</div></div></div></div><!-- Modal confirmation suppression --><div id="delete-modal" class="modal-overlay"><div class="modal" style="max-width: 400px; text-align: center;"><h2 class="modal-title">${Lang.t('gs.delete_title')}</h2><p style="color: var(--text-muted); margin-bottom: 20px;">${Lang.t('gs.delete_warn')}</p><div class="flex gap-2" style="justify-content: center;"><button class="btn btn-danger" id="delete-confirm-btn" onclick="GameServer.confirmDelete()">${Lang.t('gs.delete_btn')}</button><button class="btn btn-secondary" onclick="GameServer.hideDeleteModal()">${Lang.t('gs.cancel')}</button></div></div></div><!-- Modal réglages ressources --><div id="resources-modal" class="modal-overlay"><div class="modal" style="max-width: 500px;"><div class="flex justify-between items-center mb-4"><h2 class="modal-title" style="margin: 0;">${Lang.t('gs.resources')}</h2><button class="btn btn-secondary btn-sm" onclick="GameServer.hideResourcesModal()">${Lang.t('gs.close')}</button></div><!-- RAM Slider --><div style="margin-bottom: 24px;"><div class="flex justify-between items-center" style="margin-bottom: 8px;"><label class="form-label" style="margin: 0;">${Lang.t('gs.memory')}</label><span id="ram-value" style="font-family: monospace; font-weight: 700; color: var(--info); font-size: 16px;">2 Go</span></div><input type="range" id="ram-slider" min="0.5" max="16" step="0.5" value="2"
 style="width: 100%; accent-color: var(--info); cursor: pointer;"
 oninput="document.getElementById('ram-value').textContent = parseFloat(this.value).toFixed(1).replace(/\\.0$/, '') + ' Go'" /><div class="flex justify-between" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;"><span>0.5 Go</span><span>16 Go</span></div></div><!-- CPU Slider --><div style="margin-bottom: 24px;"><div class="flex justify-between items-center" style="margin-bottom: 8px;"><label class="form-label" style="margin: 0;">CPU</label><span id="cpu-value" style="font-family: monospace; font-weight: 700; color: var(--accent-orange); font-size: 16px;">100%</span></div><input type="range" id="cpu-slider" min="25" max="400" step="25" value="100"
 style="width: 100%; accent-color: var(--accent-orange); cursor: pointer;"
 oninput="document.getElementById('cpu-value').textContent = this.value + '%'" /><div class="flex justify-between" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;"><span>25% (¼ cœur)</span><span>400% (4 cœurs)</span></div></div><div id="resources-message" style="font-size: 13px; margin-bottom: 12px;"></div><button class="btn btn-primary" id="resources-save-btn" onclick="GameServer.saveResources()" style="width: 100%;">
 ${Lang.t('gs.apply')}
 </button></div></div><!-- Modal tâches planifiées --><div id="scheduler-modal" class="modal-overlay"><div class="modal" style="max-width: 550px;"><div class="flex justify-between items-center mb-4"><h2 class="modal-title" style="margin: 0;">${Lang.t('gs.scheduler')}</h2><button class="btn btn-secondary btn-sm" onclick="GameServer.hideSchedulerModal()">${Lang.t('gs.close')}</button></div><!-- Formulaire nouvelle tâche --><div style="background: var(--bg-elev-1); border-radius: 8px; padding: 16px; margin-bottom: 16px;"><div class="form-label" style="margin-bottom: 8px;">${Lang.t('gs.new_task')}</div><div class="flex gap-2" style="align-items: flex-end;"><div style="flex: 1;"><label style="font-size: 12px; color: var(--text-muted);">${Lang.t('gs.task_type')}</label><select id="scheduler-type" class="form-input" style="margin-top: 4px;"><option value="backup">${Lang.t('gs.backup_auto')}</option><option value="restart">${Lang.t('gs.restart_auto')}</option></select></div><div style="flex: 1;"><label style="font-size: 12px; color: var(--text-muted);">${Lang.t('gs.task_interval')}</label><select id="scheduler-interval" class="form-input" style="margin-top: 4px;"><option value="1">${Lang.t('gs.every_1h')}</option><option value="3">${Lang.t('gs.every_3h')}</option><option value="6" selected>${Lang.t('gs.every_6h')}</option><option value="12">${Lang.t('gs.every_12h')}</option><option value="24">${Lang.t('gs.every_24h')}</option><option value="48">${Lang.t('gs.every_48h')}</option><option value="168">${Lang.t('gs.every_week')}</option></select></div><button class="btn btn-primary" onclick="GameServer.createScheduledTask()">${Lang.t('gs.task_add')}</button></div></div><!-- Liste des tâches --><div id="scheduler-tasks-list"><div style="text-align: center; padding: 20px; color: var(--text-muted);">${Lang.t('common.loading')}</div></div><div id="scheduler-message" style="font-size: 13px; margin-top: 8px;"></div></div></div><!-- Modal Mods CurseForge --><div id="mods-modal" class="modal-overlay"><div class="modal" style="max-width: 700px; max-height: 85vh; display: flex; flex-direction: column;"><div class="flex justify-between items-center mb-4"><h2 class="modal-title" style="margin: 0;">Mods CurseForge</h2><button class="btn btn-secondary btn-sm" onclick="GameServer.hideModsModal()">${Lang.t('gs.close')}</button></div><!-- Tabs --><div class="flex gap-2" style="margin-bottom: 12px;"><button class="btn btn-primary btn-sm" id="mods-tab-search" onclick="GameServer.switchModsTab('search')">Rechercher</button><button class="btn btn-secondary btn-sm" id="mods-tab-installed" onclick="GameServer.switchModsTab('installed')">Installés</button></div><!-- Tab Recherche --><div id="mods-search-tab"><div class="flex gap-2" style="margin-bottom: 12px;"><input type="text" id="mods-search-input" class="form-input" placeholder="Rechercher un mod..." style="flex:1;"
 onkeydown="if(event.key==='Enter') GameServer.searchMods()" /><select id="mods-category" class="form-input" style="width: 130px;"><option value="mods">Mods</option><option value="modpacks">Modpacks</option><option value="textures">Textures</option><option value="worlds">Maps</option></select><button class="btn btn-primary" onclick="GameServer.searchMods()">Search</button></div><div id="mods-results" style="overflow-y: auto; max-height: 400px;"><div style="text-align:center;padding:30px;color:var(--text-muted);">Recherche un mod pour commencer</div></div></div><!-- Tab Installés --><div id="mods-installed-tab" style="display:none;"><div id="mods-installed-list" style="overflow-y: auto; max-height: 450px;"><div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('common.loading')}</div></div></div><div id="mods-message" style="font-size: 13px; margin-top: 8px;"></div></div></div>
 `;

 this.checkDocker();
 this.onGameChange(); // Initialiser la description du jeu
 },

 /**
 * Copie l'IP dans le presse-papier.
 */
 copyIP() {
 navigator.clipboard.writeText(this._serverIP).then(() => {
 // Petit feedback visuel
 const btn = event.target;
 const original = btn.textContent;
 btn.textContent = Lang.t('gs.copied');
 setTimeout(() => btn.textContent = original, 1500);
 });
 },

 /**
 * Met à jour les champs quand on change de jeu.
 */
 _cfPageUrl: null,
 _cfFileId: null,
 _modpackMode: 'blank',

 /**
 * Met à jour les champs quand on change de jeu.
 */
 onGameChange() {
 const select = document.getElementById('server-game-type');
 if (!select) return;

 const gameType = select.value;
 const game = this._games.find(g => g.id === gameType);
 if (!game) return;

 document.getElementById('server-port').value = game.default_port;
 document.getElementById('server-memory').value = (game.default_memory_mb / 1024).toFixed(1).replace(/\.0$/, '');

 const descEl = document.getElementById('game-description');
 if (descEl) descEl.textContent = game.description || '';

 const versionGroup = document.getElementById('version-group');
 if (versionGroup) versionGroup.style.display = game.version_env ? 'block' : 'none';

 const serverTypeGroup = document.getElementById('server-type-group');
 if (serverTypeGroup) serverTypeGroup.style.display = gameType === 'minecraft' ? 'block' : 'none';

 const customGroup = document.getElementById('custom-image-group');
 if (customGroup) customGroup.style.display = gameType === 'custom' ? 'block' : 'none';

 this._updateModpackVisibility();
 const serverTypeEl = document.getElementById('server-type-select');
 if (serverTypeEl) serverTypeEl.onchange = () => this._updateModpackVisibility();
 },

 _updateModpackVisibility() {
 const serverTypeEl = document.getElementById('server-type-select');
 const modpackGroup = document.getElementById('modpack-choice-group');
 const gameType = document.getElementById('server-game-type')?.value;
 if (!modpackGroup) return;

 const moddableTypes = ['FORGE', 'NEOFORGE', 'FABRIC', 'QUILT'];
 const serverType = serverTypeEl?.value || '';
 const show = gameType === 'minecraft' && moddableTypes.includes(serverType);
 modpackGroup.style.display = show ? 'block' : 'none';

 if (!show) {
 this._cfPageUrl = null;
 this._cfFileId = null;
 this._modpackMode = 'blank';
 const vg = document.getElementById('version-group');
 if (vg) vg.style.display = 'block';
 }
 },

 setModpackMode(mode) {
 this._modpackMode = mode;
 const blankBtn = document.getElementById('modpack-mode-blank');
 const modpackBtn = document.getElementById('modpack-mode-modpack');
 const searchArea = document.getElementById('modpack-search-area');
 const selectedArea = document.getElementById('modpack-selected');

 if (blankBtn) blankBtn.className = mode === 'blank' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
 if (modpackBtn) modpackBtn.className = mode === 'modpack' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
 if (searchArea) searchArea.style.display = mode === 'modpack' ? 'block' : 'none';
 if (selectedArea && mode === 'blank') {
 selectedArea.style.display = 'none';
 this._cfPageUrl = null;
 this._cfFileId = null;
 }
 const vg = document.getElementById('version-group');
 if (vg) vg.style.display = mode === 'blank' ? 'block' : (this._cfPageUrl ? 'none' : 'block');
 },

 async searchModpacks() {
 const q = document.getElementById('modpack-search-q')?.value?.trim();
 if (!q) return;
 const el = document.getElementById('modpack-results');
 if (!el) return;
 el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">Recherche…</div>';

 const r = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(q)}&category=modpacks`);
 if (!r || !r.ok) { el.innerHTML = '<div style="color:var(--danger);font-size:12px;">Erreur CurseForge</div>'; return; }
 const data = await r.json();
 const mods = data.mods || [];
 if (mods.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Aucun résultat</div>'; return; }

 el.innerHTML = mods.map(m => {
 const dl = m.downloads > 1000000 ? `${(m.downloads/1000000).toFixed(1)}M` : m.downloads > 1000 ? `${Math.round(m.downloads/1000)}k` : m.downloads;
 const safeUrl = (m.url||'').replace(/'/g,"\\'");
 const safeName = (m.name||'').replace(/'/g,"\\'");
 return `
 <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;cursor:pointer;transition:all .15s;" onmouseover="this.style.background='var(--bg-elev-2)'" onmouseout="this.style.background='var(--bg-elev-1)'" onclick="GameServer.selectModpack(${m.id}, '${safeName}', '${m.icon_url||''}', '${safeUrl}')"><img src="${m.icon_url||''}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;" onerror="this.style.display='none'" /><div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.name}</div><div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.summary||''}</div></div><span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${dl}</span></div>`;
 }).join('');
 },

 async selectModpack(id, name, iconUrl, pageUrl) {
 this._cfPageUrl = pageUrl;
 this._cfFileId = null;
 const el = document.getElementById('modpack-selected');
 const results = document.getElementById('modpack-results');
 if (results) results.innerHTML = '';
 if (!el) return;

 // Cacher le dropdown de version normal
 const vg = document.getElementById('version-group');
 if (vg) vg.style.display = 'none';

 el.style.display = 'block';
 el.innerHTML = `
 <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;"><img src="${iconUrl}" style="width:36px;height:36px;border-radius:8px;" onerror="this.style.display='none'" /><div style="flex:1;"><div style="font-size:14px;font-weight:700;">${name}</div><div style="font-size:10px;color:var(--text-muted);">${Lang.t('common.loading')}</div></div><button class="btn btn-secondary btn-sm" onclick="GameServer._clearModpack()" style="font-size:10px;"></button></div><div id="modpack-versions"><div style="color:var(--text-muted);font-size:12px;">${Lang.t('common.loading')}</div></div>`;

 // Charger les fichiers du modpack
 const r = await Auth.apiCall(`/api/mods/${id}/files`);
 if (!r || !r.ok) {
 document.getElementById('modpack-versions').innerHTML = '<div style="color:var(--danger);">Erreur</div>';
 return;
 }
 const files = (await r.json()).files || [];
 if (files.length === 0) {
 document.getElementById('modpack-versions').innerHTML = '<div style="color:var(--text-muted);">Aucune version</div>';
 return;
 }

 const versEl = document.getElementById('modpack-versions');
 if (!versEl) return;
 versEl.innerHTML = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${files.length} version(s) :</div>` +
 files.map(f => {
 const mcVers = (f.game_versions||[]).filter(v => /^\d/.test(v)).join(', ') || '?';
 const type = f.release_type || '';
 const typeColor = type === 'Release' ? 'var(--accent)' : type === 'Beta' ? 'var(--warning)' : 'var(--text-muted)';
 const safeName2 = (f.name||'').replace(/'/g,"\\'");
 return `
 <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-elev-3);border-radius:6px;margin-bottom:3px;cursor:pointer;transition:all .15s;" onmouseover="this.style.background='var(--bg-elev-2)'" onmouseout="this.style.background='var(--bg-elev-3)'" onclick="GameServer._pickModpackFile(${f.id}, '${safeName2}', '${mcVers}')"><div style="flex:1;"><div style="font-size:12px;font-weight:600;">${f.name}</div><div style="font-size:10px;color:var(--text-muted);">MC ${mcVers} · ${f.size_mb} Mo · <span style="color:${typeColor};">${type}</span></div></div></div>`;
 }).join('');
 },

 _pickModpackFile(fileId, fileName, mcVersion) {
 this._cfFileId = fileId;
 const verSelect = document.getElementById('server-version');
 if (verSelect) verSelect.value = mcVersion.split(',')[0]?.trim() || 'LATEST';

 const versEl = document.getElementById('modpack-versions');
 if (versEl) {
 versEl.innerHTML = `
 <div style="background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:6px;padding:10px;display:flex;align-items:center;gap:8px;"><div><div style="font-size:13px;font-weight:600;color:var(--accent);">${fileName}</div><div style="font-size:10px;color:var(--text-muted);">Minecraft ${mcVersion}</div></div></div>`;
 }
 },

 _clearModpack() {
 this._cfPageUrl = null;
 this._cfFileId = null;
 const el = document.getElementById('modpack-selected');
 if (el) el.style.display = 'none';
 const vg = document.getElementById('version-group');
 if (vg) vg.style.display = 'block';
 },

 async checkDocker() {
 const response = await Auth.apiCall('/api/servers/docker-status');
 if (response) {
 const data = await response.json();
 const warning = document.getElementById('docker-warning');
 if (warning) warning.classList.toggle('hidden', data.available);
 }
 },

 async refreshServers() {
 const response = await Auth.apiCall('/api/servers/');
 if (!response) return;
 const servers = await response.json();
 this._servers = servers;
 this.renderServers(servers);
 },

 /**
 * Affiche la liste des serveurs avec l'IP de connexion.
 */
 renderServers(servers) {
 const list = document.getElementById('server-list');
 if (!list) return;

 if (servers.length === 0) {
 list.innerHTML = `
 <div class="text-center" style="padding: 60px; color: var(--text-muted);"><p style="font-size: 16px; margin-bottom: 8px;">${Lang.t('gs.no_servers')}</p><p style="font-size: 13px;">${Lang.t('gs.no_servers_hint')}</p></div>
 `;
 return;
 }

 list.innerHTML = servers.map(server => {
 const pending = this._pendingStates[server.id];
 const isRunning = !pending && server.status === 'running';
 const isPending = !!pending;

 let statusClass, statusText;
 if (pending === 'starting') {
 statusClass = 'starting';
 statusText = Lang.t('gs.starting');
 } else if (pending === 'stopping') {
 statusClass = 'stopping';
 statusText = Lang.t('gs.stopping');
 } else if (pending === 'restarting') {
 statusClass = 'restarting';
 statusText = Lang.t('gs.restarting');
 } else if (isRunning) {
 statusClass = 'online';
 statusText = Lang.t('gs.online');
 } else if (server.status === 'error') {
 statusClass = 'error';
 statusText = Lang.t('gs.error');
 } else {
 statusClass = 'offline';
 statusText = Lang.t('gs.offline');
 }

 // Trouver l'icône du jeu
 const game = this._games.find(g => g.id === server.game_type);
 const icon = game ? (game.icon || 'GAME') : 'GAME';
 const gameName = game ? game.name : server.game_type;


 return `
 <div class="server-item fade-in" onclick="App.navigateTo('server_view', ${server.id})" style="cursor:pointer;"><div class="server-info"><span class="server-icon">${icon}</span><div><div class="server-name">${server.name}</div><div class="server-meta">
 ${gameName} · v${server.version === 'LATEST' ? 'latest' : server.version} · ${(server.memory_mb / 1024).toFixed(1).replace(/\.0$/, '')} Go RAM · ${server.cpu_percent || 100}% CPU
 </div></div></div><div class="flex items-center gap-4"><span class="status-badge ${statusClass}"${isPending ? ' style="animation:pulse-badge 1.5s ease-in-out infinite;"' : ''}>
 ${isPending ? '' : ``}
 ${statusText}
 </span>
 ${isRunning ? `<span style="font-size:12px;color:var(--info);font-weight:600;">${server.player_count || 0}/${server.player_max || 20}</span>` : ''}
 <div class="server-actions" onclick="event.stopPropagation()">
 ${(() => {
 const u = Auth.getUser();
 const al = server.access_level || 'view_only';
 const canManage = al === 'owner' || al === 'manage';
 const canStart = canManage || al === 'start';
 const isOwner = u && (u.is_admin || server.owner_id === u.id);
 let btns = '';
 if (isPending) {
 btns = `<button class="btn btn-icon btn-secondary" disabled style="opacity:0.5;">…</button>`;
 } else if (isRunning) {
 btns = canManage ? `
 <button class="btn btn-secondary btn-sm" onclick="GameServer.stopServer(${server.id})" title="${Lang.t('common.stop')}">${Lang.t('common.stop')}</button><button class="btn btn-secondary btn-sm" onclick="GameServer.restartServer(${server.id})" title="${Lang.t('common.restart')}">${Lang.t('common.restart')}</button>
 ` : '';
 } else {
 btns = canStart ? `<button class="btn btn-primary btn-sm" onclick="GameServer.startServer(${server.id})" title="${Lang.t('common.start')}">${Lang.t('common.start')}</button>` : '';
 }
 // Share button for owner only
 if (isOwner) {
 btns += `<button class="btn btn-secondary btn-sm" onclick="SharingModal.open(${server.id},'server')" title="${Lang.t('sharing.title')}">${Lang.t('sharing.share_btn')}</button>`;
 }
 return btns;
 })()}
 </div></div></div>
 `;
 }).join('');
 },

 startStatusRefresh() {
 this._statusInterval = setInterval(() => this.refreshServers(), 5000);
 },

 // --- Actions serveur ---

 /** 
 * Map des serveurs en cours de transition : id → 'starting' | 'stopping' | 'restarting'
 */
 _pendingStates: {},

 async startServer(id) {
 this._pendingStates[id] = 'starting';
 this._renderPendingCard(id);
 const response = await Auth.apiCall(`/api/servers/${id}/start`, { method: 'POST' });
 if (response && response.ok) {
 this._pollUntilState(id, 'running', 'starting');
 } else {
 delete this._pendingStates[id];
 await this.refreshServers();
 }
 },

 async stopServer(id) {
 this._pendingStates[id] = 'stopping';
 this._renderPendingCard(id);
 const response = await Auth.apiCall(`/api/servers/${id}/stop`, { method: 'POST' });
 if (response && response.ok) {
 this._pollUntilState(id, 'exited', 'stopping');
 } else {
 delete this._pendingStates[id];
 await this.refreshServers();
 }
 },

 async restartServer(id) {
 this._pendingStates[id] = 'restarting';
 this._renderPendingCard(id);
 const response = await Auth.apiCall(`/api/servers/${id}/restart`, { method: 'POST' });
 if (response && response.ok) {
 this._pollUntilState(id, 'running', 'restarting');
 } else {
 delete this._pendingStates[id];
 await this.refreshServers();
 }
 },

 /**
 * Poll le statut du serveur toutes les 3s jusqu'à l'état cible.
 * Pour start/restart : attend que ready=true (jeu opérationnel, pas juste Docker).
 * Timeout après 120s.
 */
 _pollUntilState(id, targetState, pendingType) {
 let attempts = 0;
 const maxAttempts = 40; // 40 × 3s = 120s max
 // Délai initial : laisser Docker le temps de démarrer
 const initialDelay = (pendingType === 'starting' || pendingType === 'restarting') ? 5000 : 2000;
 setTimeout(() => {
 const interval = setInterval(async () => {
 attempts++;
 try {
 const r = await Auth.apiCall(`/api/servers/${id}`);
 if (r && r.ok) {
 const data = await r.json();
 let ready;
 if (targetState === 'exited') {
 // Pour stop : vérifier que le statut n'est plus running
 ready = data.status !== 'running';
 } else {
 // Pour start/restart : vérifier que le jeu répond (ready=true)
 ready = data.status === 'running' && data.ready === true;
 }
 if (ready || attempts >= maxAttempts) {
 clearInterval(interval);
 delete this._pendingStates[id];
 await this.refreshServers();
 if (ready && typeof Toast !== 'undefined') {
 const labels = {
 starting: Lang.t('gs.toast_started'),
 stopping: Lang.t('gs.toast_stopped'),
 restarting: Lang.t('gs.toast_restarted'),
 };
 Toast.success(labels[pendingType] || 'OK');
 } else if (attempts >= maxAttempts && typeof Toast !== 'undefined') {
 Toast.error(Lang.t('gs.toast_timeout'));
 }
 }
 }
 } catch (e) {
 // Ignorer les erreurs réseau pendant le polling
 }
 }, 3000);
 }, initialDelay);
 },

 /**
 * Met à jour visuellement la carte d'un serveur pendant la transition.
 */
 _renderPendingCard(id) {
 // Mettre à jour le badge de statut
 const list = document.getElementById('server-list');
 if (!list) return;
 // On rafraîchit toute la liste pour intégrer l'état pending
 this.renderServers(this._servers || []);
 },

 _deleteServerId: null,

 deleteServer(id) {
 // Stopper le refresh pour éviter les conflits DOM
 if (this._statusInterval) {
 clearInterval(this._statusInterval);
 this._statusInterval = null;
 }
 this._deleteServerId = id;
 const modal = document.getElementById('delete-modal');
 if (modal) modal.classList.add('active');
 // Reset le bouton au cas où il était resté en "Suppression..."
 const btn = document.getElementById('delete-confirm-btn');
 if (btn) { btn.disabled = false; btn.innerHTML = 'Supprimer'; }
 },

 hideDeleteModal() {
 const modal = document.getElementById('delete-modal');
 if (modal) modal.classList.remove('active');
 this._deleteServerId = null;
 // Reset le bouton
 const btn = document.getElementById('delete-confirm-btn');
 if (btn) { btn.disabled = false; btn.innerHTML = 'Supprimer'; }
 // Redémarrer le refresh
 this.startStatusRefresh();
 },

 async confirmDelete() {
 const id = this._deleteServerId;
 if (!id) return;

 const btn = document.getElementById('delete-confirm-btn');
 if (btn) { btn.disabled = true; btn.textContent = '…'; }

 try {
 const response = await Auth.apiCall(`/api/servers/${id}`, { method: 'DELETE' });

 // Fermer le modal DANS TOUS LES CAS
 this.hideDeleteModal();

 if (response && response.ok) {
 await this.refreshServers();
 } else if (response) {
 const err = await response.json();
 if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Impossible de supprimer');
 else alert(`Erreur: ${err.detail || 'Impossible de supprimer'}`);
 }
 } catch (e) {
 this.hideDeleteModal();
 if (typeof Toast !== 'undefined') Toast.error('Erreur réseau lors de la suppression');
 else alert('Erreur réseau lors de la suppression');
 }
 },

 // --- Réglages ressources ---

 _resourcesServerId: null,

 showResources(serverId, currentRam, currentCpu) {
 this._resourcesServerId = serverId;
 const modal = document.getElementById('resources-modal');
 const ramSlider = document.getElementById('ram-slider');
 const cpuSlider = document.getElementById('cpu-slider');
 const ramValue = document.getElementById('ram-value');
 const cpuValue = document.getElementById('cpu-value');
 const msgEl = document.getElementById('resources-message');

 if (ramSlider) { ramSlider.value = (currentRam / 1024).toFixed(1); }
 if (cpuSlider) { cpuSlider.value = currentCpu; }
 if (ramValue) { ramValue.textContent = (currentRam / 1024).toFixed(1).replace(/\.0$/, '') + ' Go'; }
 if (cpuValue) { cpuValue.textContent = currentCpu + '%'; }
 if (msgEl) { msgEl.textContent = ''; }

 if (modal) modal.classList.add('active');
 },

 hideResourcesModal() {
 const modal = document.getElementById('resources-modal');
 if (modal) modal.classList.remove('active');
 this._resourcesServerId = null;
 },

 async saveResources() {
 const id = this._resourcesServerId;
 if (!id) return;

 const ramGb = parseFloat(document.getElementById('ram-slider').value);
 const ram = Math.round(ramGb * 1024);
 const cpu = parseInt(document.getElementById('cpu-slider').value);
 const btn = document.getElementById('resources-save-btn');
 const msgEl = document.getElementById('resources-message');

 if (btn) { btn.disabled = true; btn.textContent = '…'; }

 try {
 const response = await Auth.apiCall(`/api/servers/${id}/resources`, {
 method: 'PUT',
 body: JSON.stringify({ memory_mb: ram, cpu_percent: cpu }),
 });

 if (btn) { btn.disabled = false; btn.innerHTML = 'Appliquer les changements'; }

 if (response && response.ok) {
 if (msgEl) {
 msgEl.style.color = 'var(--accent)';
 msgEl.textContent = 'Ressources mises à jour !';
 }
 await this.refreshServers();
 // Fermer après 1s
 setTimeout(() => this.hideResourcesModal(), 1000);
 } else if (response) {
 const err = await response.json();
 if (msgEl) {
 msgEl.style.color = 'var(--danger)';
 msgEl.textContent = `${err.detail || 'Erreur'}`;
 }
 }
 } catch (e) {
 if (btn) { btn.disabled = false; btn.innerHTML = 'Appliquer les changements'; }
 if (msgEl) {
 msgEl.style.color = 'var(--danger)';
 msgEl.textContent = 'Erreur réseau';
 }
 }
 },

 // --- Tâches planifiées ---

 _schedulerServerId: null,

 async showScheduler(serverId) {
 this._schedulerServerId = serverId;
 const modal = document.getElementById('scheduler-modal');
 const msgEl = document.getElementById('scheduler-message');
 if (msgEl) msgEl.textContent = '';
 if (modal) modal.classList.add('active');
 await this.loadSchedulerTasks();
 },

 hideSchedulerModal() {
 const modal = document.getElementById('scheduler-modal');
 if (modal) modal.classList.remove('active');
 this._schedulerServerId = null;
 },

 async loadSchedulerTasks() {
 const id = this._schedulerServerId;
 if (!id) return;

 const listEl = document.getElementById('scheduler-tasks-list');
 const response = await Auth.apiCall(`/api/scheduler/server/${id}`);
 if (!response || !response.ok) {
 if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);">Erreur de chargement</div>';
 return;
 }

 const tasks = await response.json();
 if (tasks.length === 0) {
 listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);">Aucune tâche planifiée</div>';
 return;
 }

 listEl.innerHTML = tasks.map(task => {
 const typeLabel = task.task_type === 'backup' ? Lang.t('scheduler.backup') : Lang.t('scheduler.restart');
 const statusColor = task.enabled ? 'var(--accent)' : 'var(--text-muted)';
 const statusLabel = task.enabled ? ' Actif' : ' Inactif';
 const lastRun = task.last_run ? new Date(task.last_run).toLocaleString('fr-FR') : 'Jamais';
 const nextRun = task.next_run && task.enabled ? new Date(task.next_run).toLocaleString('fr-FR') : '—';

 return `
 <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:8px;"><div><div style="font-weight:600;">${typeLabel} auto</div><div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
 ⏱Toutes les ${task.interval_hours}h &nbsp;|&nbsp;
 Dernier: ${lastRun} &nbsp;|&nbsp;
 ⏭Prochain: ${nextRun}
 </div></div><div class="flex gap-2" style="align-items:center;"><span style="color:${statusColor};font-size:12px;font-weight:600;">${statusLabel}</span><button class="btn btn-icon btn-secondary" onclick="GameServer.toggleScheduledTask(${task.id})" title="${task.enabled ? 'Désactiver' : 'Activer'}">
 ${task.enabled ? 'Pause' : 'Resume'}
 </button><button class="btn btn-icon btn-danger" onclick="GameServer.deleteScheduledTask(${task.id})" title="Supprimer">Del</button></div></div>
 `;
 }).join('');
 },

 async createScheduledTask() {
 const id = this._schedulerServerId;
 if (!id) return;

 const taskType = document.getElementById('scheduler-type').value;
 const interval = parseInt(document.getElementById('scheduler-interval').value);
 const msgEl = document.getElementById('scheduler-message');

 const response = await Auth.apiCall('/api/scheduler/', {
 method: 'POST',
 body: JSON.stringify({ server_id: id, task_type: taskType, interval_hours: interval }),
 });

 if (response && response.ok) {
 if (msgEl) { msgEl.style.color = 'var(--accent)'; msgEl.textContent = 'Tâche créée !'; }
 await this.loadSchedulerTasks();
 } else if (response) {
 const err = await response.json();
 if (msgEl) { msgEl.style.color = 'var(--danger)'; msgEl.textContent = `${err.detail || 'Erreur'}`; }
 }
 },

 async toggleScheduledTask(taskId) {
 const response = await Auth.apiCall(`/api/scheduler/${taskId}/toggle`, { method: 'POST' });
 if (response && response.ok) await this.loadSchedulerTasks();
 },

 async deleteScheduledTask(taskId) {
 const response = await Auth.apiCall(`/api/scheduler/${taskId}`, { method: 'DELETE' });
 if (response && response.ok) await this.loadSchedulerTasks();
 },

 // --- Mods CurseForge ---

 _modsServerId: null,

 showMods(serverId) {
 this._modsServerId = serverId;
 const modal = document.getElementById('mods-modal');
 const msgEl = document.getElementById('mods-message');
 if (msgEl) msgEl.textContent = '';
 if (modal) modal.classList.add('active');
 this.switchModsTab('search');
 },

 hideModsModal() {
 const modal = document.getElementById('mods-modal');
 if (modal) modal.classList.remove('active');
 this._modsServerId = null;
 },

 switchModsTab(tab) {
 const searchTab = document.getElementById('mods-search-tab');
 const installedTab = document.getElementById('mods-installed-tab');
 const tabSearch = document.getElementById('mods-tab-search');
 const tabInstalled = document.getElementById('mods-tab-installed');

 if (tab === 'search') {
 searchTab.style.display = 'block';
 installedTab.style.display = 'none';
 tabSearch.className = 'btn btn-primary btn-sm';
 tabInstalled.className = 'btn btn-secondary btn-sm';
 } else {
 searchTab.style.display = 'none';
 installedTab.style.display = 'block';
 tabSearch.className = 'btn btn-secondary btn-sm';
 tabInstalled.className = 'btn btn-primary btn-sm';
 this.loadInstalledMods();
 }
 },

 async searchMods() {
 const query = document.getElementById('mods-search-input').value.trim();
 const category = document.getElementById('mods-category').value;
 const resultsEl = document.getElementById('mods-results');

 if (!query) return;

 resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Recherche…</div>';

 const response = await Auth.apiCall(`/api/mods/search?q=${encodeURIComponent(query)}&category=${category}`);
 if (!response || !response.ok) {
 const err = response ? await response.json() : {};
 resultsEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);">${err.detail || 'Erreur de recherche'}</div>`;
 return;
 }

 const data = await response.json();
 const mods = data.mods || [];

 if (mods.length === 0) {
 resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Aucun résultat</div>';
 return;
 }

 resultsEl.innerHTML = mods.map(mod => {
 const downloads = mod.downloads > 1000000 ? `${(mod.downloads/1000000).toFixed(1)}M` :
 mod.downloads > 1000 ? `${(mod.downloads/1000).toFixed(0)}K` :
 mod.downloads;
 return `
 <div style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;"><img src="${mod.icon_url || ''}" alt="" style="width:40px;height:40px;border-radius:6px;background:var(--bg-elev-3);" onerror="this.style.display='none'" /><div style="flex:1;min-width:0;"><div style="font-weight:600;font-size:14px;">${mod.name}</div><div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
 ${mod.summary}
 </div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
 ${mod.author} · ⬇${downloads}
 </div></div><button class="btn btn-primary btn-sm" onclick="GameServer.showModFiles(${mod.id}, '${mod.name.replace(/'/g, "\\'")}')">Installer</button></div>
 `;
 }).join('');
 },

 async showModFiles(modId, modName) {
 const resultsEl = document.getElementById('mods-results');
 resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">' + Lang.t('common.loading') + '</div>';

 const response = await Auth.apiCall(`/api/mods/${modId}/files`);
 if (!response || !response.ok) {
 resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger);">Erreur</div>';
 return;
 }

 const data = await response.json();
 const files = data.files || [];

 if (files.length === 0) {
 resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Aucun fichier disponible</div>';
 return;
 }

 resultsEl.innerHTML = `
 <div style="margin-bottom:8px;"><button class="btn btn-secondary btn-sm" onclick="GameServer.searchMods()">← Retour</button><span style="font-weight:600;margin-left:8px;">${modName}</span></div>
 ` + files.slice(0, 10).map(f => {
 const versions = f.game_versions.slice(0, 3).join(', ');
 const badge = f.release_type;
 const hasUrl = f.download_url ? true : false;
 return `
 <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;"><div><div style="font-size:13px;">${badge} ${f.name} <span style="color:var(--text-muted);font-size:11px;">(${f.size_mb} Mo)</span></div><div style="font-size:11px;color:var(--text-muted);">${versions}</div></div>
 ${hasUrl ? `<button class="btn btn-primary btn-sm" onclick="GameServer.installMod('${modName.replace(/'/g, "\\'")}', '${f.download_url}', '${f.name}')"></button>` : '<span style="font-size:11px;color:var(--text-muted);">Non dispo</span>'}
 </div>
 `;
 }).join('');
 },

 async installMod(modName, downloadUrl, filename) {
 const id = this._modsServerId;
 if (!id) return;
 const msgEl = document.getElementById('mods-message');

 if (msgEl) { msgEl.style.color = 'var(--info)'; msgEl.textContent = '…'; }

 const response = await Auth.apiCall('/api/mods/install', {
 method: 'POST',
 body: JSON.stringify({ server_id: id, mod_name: modName, download_url: downloadUrl, filename: filename }),
 });

 if (response && response.ok) {
 if (msgEl) { msgEl.style.color = 'var(--accent)'; msgEl.textContent = `${modName} installé !`; }
 } else if (response) {
 const err = await response.json();
 if (msgEl) { msgEl.style.color = 'var(--danger)'; msgEl.textContent = `${err.detail || 'Erreur'}`; }
 }
 },

 async loadInstalledMods() {
 const id = this._modsServerId;
 if (!id) return;

 const listEl = document.getElementById('mods-installed-list');
 const response = await Auth.apiCall(`/api/mods/server/${id}`);
 if (!response || !response.ok) {
 listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Erreur</div>';
 return;
 }

 const data = await response.json();
 const mods = data.mods || [];

 if (mods.length === 0) {
 listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Aucun mod installé</div>';
 return;
 }

 listEl.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${mods.length} mod(s) installé(s)</div>` +
 mods.map(m => `
 <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-elev-1);border-radius:6px;margin-bottom:4px;"><div><div style="font-size:13px;">${m.filename}</div><div style="font-size:11px;color:var(--text-muted);">${m.size_mb} Mo</div></div><button class="btn btn-icon btn-danger" onclick="GameServer.removeMod('${m.filename}')" title="Supprimer">Del</button></div>
 `).join('');
 },

 async removeMod(filename) {
 const id = this._modsServerId;
 if (!id) return;
 const response = await Auth.apiCall(`/api/mods/server/${id}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
 if (response && response.ok) {
 await this.loadInstalledMods();
 const msgEl = document.getElementById('mods-message');
 if (msgEl) { msgEl.style.color = 'var(--accent)'; msgEl.textContent = `${filename} supprimé`; }
 }
 },

 /**
 * Ouvre la console live WebSocket pour un serveur.
 */
 async showLogs(id) {
 const modal = document.getElementById('logs-modal');
 const logsEl = document.getElementById('server-logs');
 const statusEl = document.getElementById('console-status');
 if (modal) modal.classList.add('active');
 if (logsEl) logsEl.innerHTML = '';

 // Stocker l'ID du serveur pour l'envoi de commandes
 this._currentConsoleId = id;

 // Fermer une connexion précédente
 this.closeConsoleWS();

 // Connexion WebSocket
 const token = Auth.getToken();
 const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
 const wsUrl = `${protocol}//${location.host}/ws/servers/${id}/console?token=${token}`;

 if (statusEl) {
 statusEl.textContent = 'Connexion...';
 statusEl.style.background = 'var(--warning)';
 statusEl.style.color = '#000';
 }

 try {
 this._consoleWS = new WebSocket(wsUrl);

 this._consoleWS.onopen = () => {
 if (statusEl) {
 statusEl.textContent = 'En direct';
 statusEl.style.background = 'rgba(46, 204, 113, 0.2)';
 statusEl.style.color = 'var(--accent)';
 }
 };

 this._consoleWS.onmessage = (event) => {
 const msg = JSON.parse(event.data);
 this.appendConsoleLine(msg);
 };

 this._consoleWS.onclose = () => {
 if (statusEl) {
 statusEl.textContent = 'Déconnecté';
 statusEl.style.background = 'var(--bg-elev-2)';
 statusEl.style.color = 'var(--text-muted)';
 }
 };

 this._consoleWS.onerror = () => {
 // Fallback: charger les logs via API REST
 this.loadStaticLogs(id);
 };
 } catch (e) {
 // Fallback si WebSocket échoue
 this.loadStaticLogs(id);
 }
 },

 /**
 * Fallback: charge les logs via l'API REST (si WebSocket échoue).
 */
 async loadStaticLogs(id) {
 const logsEl = document.getElementById('server-logs');
 const statusEl = document.getElementById('console-status');
 if (statusEl) {
 statusEl.textContent = 'Mode statique';
 statusEl.style.background = 'var(--bg-elev-2)';
 statusEl.style.color = 'var(--text-muted)';
 }
 const response = await Auth.apiCall(`/api/servers/${id}/logs?tail=100`);
 if (response) {
 const data = await response.json();
 if (logsEl) logsEl.textContent = data.logs || 'Aucun log disponible';
 }
 },

 /**
 * Ajoute une ligne dans la console avec coloration.
 */
 appendConsoleLine(msg) {
 const logsEl = document.getElementById('server-logs');
 if (!logsEl) return;

 const line = document.createElement('div');
 const text = msg.data || msg.message || '';

 if (msg.type === 'error') {
 line.style.color = 'var(--danger)';
 line.textContent = `${text}`;
 } else if (msg.type === 'info') {
 line.style.color = 'var(--info)';
 line.textContent = text;
 } else {
 line.style.color = 'var(--text)';
 line.textContent = text;
 }

 logsEl.appendChild(line);

 // Auto-scroll vers le bas
 logsEl.scrollTop = logsEl.scrollHeight;

 // Limiter à 500 lignes max (performance)
 while (logsEl.children.length > 500) {
 logsEl.removeChild(logsEl.firstChild);
 }
 },

 /**
 * Envoie une commande au serveur via WebSocket.
 */
 sendCommand() {
 const input = document.getElementById('console-command');
 if (!input) return;
 const cmd = input.value.trim();
 if (!cmd) return;

 if (this._consoleWS && this._consoleWS.readyState === WebSocket.OPEN) {
 this._consoleWS.send(JSON.stringify({ type: 'command', data: cmd }));
 input.value = '';
 } else {
 this.appendConsoleLine({ type: 'error', message: 'Console non connectée' });
 }
 },

 /**
 * Ferme la connexion WebSocket de la console.
 */
 closeConsoleWS() {
 if (this._consoleWS) {
 this._consoleWS.close();
 this._consoleWS = null;
 }
 },

 hideLogsModal() {
 const modal = document.getElementById('logs-modal');
 if (modal) modal.classList.remove('active');
 this.closeConsoleWS();
 },

 // --- Création ---

 showCreateModal() {
 const modal = document.getElementById('create-modal');
 if (modal) modal.classList.add('active');
 document.getElementById('create-error').classList.remove('show');
 document.getElementById('create-loading').classList.add('hidden');
 document.getElementById('create-buttons').style.display = '';

 // Handler pour le dropdown version → afficher champ custom si "Personnalisée"
 const versionSelect = document.getElementById('server-version');
 const versionCustom = document.getElementById('server-version-custom');
 if (versionSelect && versionCustom) {
 versionSelect.onchange = () => {
 versionCustom.style.display = versionSelect.value === 'CUSTOM' ? 'block' : 'none';
 if (versionSelect.value === 'CUSTOM') versionCustom.focus();
 };
 }
 },

 hideCreateModal() {
 const modal = document.getElementById('create-modal');
 if (modal) modal.classList.remove('active');
 },

 async createServer() {
 const name = document.getElementById('server-name').value.trim();
 const gameType = document.getElementById('server-game-type').value;
 const versionSelect = document.getElementById('server-version');
 const versionCustom = document.getElementById('server-version-custom');
 let version = versionSelect ? versionSelect.value : 'LATEST';
 // Si "Personnalisée" est sélectionné, utiliser le champ texte
 if (version === 'CUSTOM') {
 version = versionCustom ? versionCustom.value.trim() : 'LATEST';
 if (!version) { this.showCreateError('Entre une version personnalisée'); return; }
 }
 const port = parseInt(document.getElementById('server-port').value);
 const memoryGb = parseFloat(document.getElementById('server-memory').value);
 const memory = Math.round(memoryGb * 1024);
 const customImage = document.getElementById('server-custom-image')?.value?.trim();

 if (!name) {
 this.showCreateError('Entre un nom pour le serveur');
 return;
 }

 // Afficher le loading (le téléchargement peut prendre du temps)
 document.getElementById('create-loading').classList.remove('hidden');
 document.getElementById('create-buttons').style.display = 'none';
 document.getElementById('create-error').classList.remove('show');

 const body = { name, game_type: gameType, version, port, memory_mb: memory };
 // Ajouter le server_type pour Minecraft
 const serverTypeEl = document.getElementById('server-type-select');
 if (serverTypeEl && gameType === 'minecraft') {
 body.server_type = serverTypeEl.value;
 }
 if (gameType === 'custom' && customImage) {
 body.custom_image = customImage;
 }
 // Ajouter le modpack CurseForge si sélectionné
 if (this._cfPageUrl) {
 body.cf_page_url = this._cfPageUrl;
 if (this._cfFileId) body.cf_file_id = this._cfFileId;
 }

 // Adapter le message de chargement
 const loadingEl = document.getElementById('create-loading');
 if (loadingEl) {
 loadingEl.textContent = this._cfPageUrl
 ? 'Création du serveur + téléchargement du modpack… Ça peut prendre plusieurs minutes.'
 : 'Téléchargement de l\'image Docker… Ça peut prendre quelques minutes la première fois.';
 }

 const response = await Auth.apiCall('/api/servers/', {
 method: 'POST',
 body: JSON.stringify(body),
 });

 document.getElementById('create-loading').classList.add('hidden');
 document.getElementById('create-buttons').style.display = '';

 if (response && response.ok) {
 this._cfPageUrl = null;
 this._cfFileId = null;
 this._modpackMode = 'blank';
 this.hideCreateModal();
 await this.refreshServers();
 } else if (response) {
 const err = await response.json();
 this.showCreateError(err.detail || 'Erreur lors de la création');
 }
 },

 showCreateError(msg) {
 const el = document.getElementById('create-error');
 if (el) { el.textContent = msg; el.classList.add('show'); }
 },

 // --- Sauvegardes ---

 _currentBackupServerId: null,

 /**
 * Ouvre le modal de sauvegardes et charge la liste.
 */
 async showBackups(serverId) {
 this._currentBackupServerId = serverId;
 const modal = document.getElementById('backups-modal');
 if (modal) modal.classList.add('active');
 await this.refreshBackups();
 },

 hideBackupsModal() {
 const modal = document.getElementById('backups-modal');
 if (modal) modal.classList.remove('active');
 this._currentBackupServerId = null;
 },

 /**
 * Rafraîchit la liste des sauvegardes.
 */
 async refreshBackups() {
 const id = this._currentBackupServerId;
 if (!id) return;

 const listEl = document.getElementById('backups-list');
 if (!listEl) return;

 const response = await Auth.apiCall(`/api/servers/${id}/backups`);
 if (!response) return;

 const data = await response.json();
 const backups = data.backups || [];

 if (backups.length === 0) {
 listEl.innerHTML = `
 <div style="text-align: center; padding: 40px; color: var(--text-muted);"><div style="font-size: 36px; margin-bottom: 12px;"></div><p>Aucune sauvegarde pour le moment</p><p style="font-size: 12px;">Clique sur "Sauvegarder maintenant" pour en créer une</p></div>
 `;
 return;
 }

 listEl.innerHTML = backups.map(b => `
 <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border);"><div><div style="font-weight: 600; font-size: 14px;">${b.filename}</div><div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
 ${b.created_at} · ${b.size_mb} Mo
 </div></div><div class="flex gap-2"><button class="btn btn-secondary btn-sm" onclick="GameServer.restoreBackup('${b.id}')" title="Restaurer">
 Restaurer
 </button><button class="btn btn-danger btn-sm" onclick="GameServer.deleteBackup('${b.id}')" title="Supprimer">
 Del
 </button></div></div>
 `).join('');
 },

 /**
 * Crée une sauvegarde du serveur actuel.
 */
 async createBackup() {
 const id = this._currentBackupServerId;
 if (!id) return;

 const btn = document.getElementById('backup-create-btn');
 if (btn) {
 btn.disabled = true;
 btn.textContent = '…';
 }

 const response = await Auth.apiCall(`/api/servers/${id}/backup`, { method: 'POST' });

 if (btn) {
 btn.disabled = false;
 btn.textContent = 'Sauvegarder maintenant';
 }

 if (response && response.ok) {
 await this.refreshBackups();
 } else if (response) {
 const err = await response.json();
 if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Impossible de sauvegarder');
 else alert(`Erreur: ${err.detail || 'Impossible de sauvegarder'}`);
 }
 },

 /**
 * Restaure une sauvegarde (demande confirmation).
 */
 async restoreBackup(backupId) {
 if (!confirm('Restaurer cette sauvegarde ?\n\nLe serveur doit être arrêté.\nLes données actuelles seront remplacées.')) return;

 const id = this._currentBackupServerId;
 if (!id) return;

 const response = await Auth.apiCall(`/api/servers/${id}/restore/${backupId}`, { method: 'POST' });

 if (response && response.ok) {
 if (typeof Toast !== 'undefined') Toast.success('Sauvegarde restaurée avec succès !');
 else alert('Sauvegarde restaurée avec succès !');
 } else if (response) {
 const err = await response.json();
 if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Impossible de restaurer');
 else alert(`Erreur: ${err.detail || 'Impossible de restaurer'}`);
 }
 },

 /**
 * Supprime une sauvegarde (demande confirmation).
 */
 async deleteBackup(backupId) {
 if (!confirm('Supprimer cette sauvegarde ? Cette action est irréversible.')) return;

 const id = this._currentBackupServerId;
 if (!id) return;

 const response = await Auth.apiCall(`/api/servers/${id}/backups/${backupId}`, { method: 'DELETE' });

 if (response && response.ok) {
 await this.refreshBackups();
 } else if (response) {
 const err = await response.json();
 if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Impossible de supprimer');
 else alert(`Erreur: ${err.detail || 'Impossible de supprimer'}`);
 }
 },
};
