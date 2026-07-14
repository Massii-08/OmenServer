/**
 * BotsModule — Interface du Module Bots & Automatisation.
 * 
 * Permet de créer, éditer, démarrer, arrêter et monitorer des bots Python
 * directement depuis le panel OmenServer.
 * Inclut la planification de tâches automatiques (start/stop/restart).
 */
const BotsModule = {
 _bots: [],
 _selectedBot: null,
 _refreshInterval: null,

 async render(container) {
 console.log('[BotsModule] render() called');
 this._container = container;
 container.innerHTML = `
 <div id="bots-module-container"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;"><div><h1 style="margin:0;">${Lang.t('bots.title')}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:4px;">${Lang.t('bots.subtitle')}</p></div><div style="display:flex;gap:8px;align-items:center;">
 ${(() => {
 const u = Auth.getUser();
 const canCreate = u && (u.is_admin || u.role === 'developer');
 if (!canCreate) return '';
 return `<button class="btn btn-primary" onclick="BotsModule.showCreateForm()">${Lang.t('bots.new')}</button>`;
 })()}
 <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Hub</button></div></div><div id="bot-create-form" style="display:none;margin-bottom:20px;"></div><div id="bots-grid"><div style="text-align:center;padding:20px;color:var(--text-muted);">${Lang.t('bots.loading')}</div></div><div id="bot-detail" style="display:none;margin-top:20px;"></div></div>
 `;

 try {
 await this.loadBots();
 } catch (e) {
 console.error('[BotsModule] loadBots error:', e);
 }

 // Refresh auto toutes les 5s
 this._refreshInterval = setInterval(() => this.loadBots(), 5000);
 },

 unload() {
 if (this._refreshInterval) {
 clearInterval(this._refreshInterval);
 this._refreshInterval = null;
 }
 this._mcaMapStop();
 this._mcaWorkersStop();
 // Ne PAS arrêter le polling yield ici — le backend continue de tourner
 // On nettoie seulement l'interval, le jobId reste en mémoire pour reconnexion
 if (this._yieldState.pollInterval) {
 clearInterval(this._yieldState.pollInterval);
 this._yieldState.pollInterval = null;
 }
 // Coupe le poll du dashboard Oracle si on quitte l'onglet en étant dessus
 if (typeof OracleModule !== 'undefined' && OracleModule.unload) {
 OracleModule.unload();
 }
 },

 async loadBots() {
 const r = await Auth.apiCall('/api/bots');
 if (!r || !r.ok) return;
 this._bots = await r.json();
 this._renderGrid();
 },

 _renderGrid() {
 const grid = document.getElementById('bots-grid');
 if (!grid) return;

 // PR27 — text tickers (mono, 3-char) au lieu d'emojis pour bot types
 const typeTickers = { trading: 'TRD', gaming: 'GMG', scraper: 'SCR', analysis: 'ANL', custom: 'CST' };
 const statusClassMap = { running: 'online', stopped: '', error: 'danger', idle: '' };
 const statusLabels = { running: Lang.t('bots.running'), stopped: Lang.t('bots.stopped'), error: Lang.t('bots.error') };

 // PR 8 — Bento Tech card builder (replaces inline-styled cards)
 // PR27 — `.b-icon` rendered as mono text ticker chip (game-ico style)
 const buildBotCard = ({ icon, name, type, desc, status, statusLabel, onClick, actions, selected, sharedWithYou }) => `
 <div class="bot-card-bento ${selected ? 'selected' : ''}" onclick="${onClick}"><div class="b-head"><span class="b-icon b-ticker">${icon}</span><div class="b-name-wrap"><div class="b-name">${name}</div><div class="b-type">${type}${sharedWithYou ? ' · <span class="b-shared">' + Lang.t('sharing.shared_with_you') + '</span>' : ''}</div></div><span class="badge ${status}">${statusLabel}</span></div><div class="b-desc">${desc}</div><div class="b-actions">${actions}</div></div>`;

 const u = Auth.getUser();
 const canSeeYield = u && (u.is_admin || u.role === 'money' || u.role === 'admin');
 const canSeeScanner = u && (u.is_admin || u.role === 'money' || u.role === 'admin');

 // Yield Bot virtual card
 const yieldBotCard = canSeeYield ? buildBotCard({
 icon: 'YLD',
 name: 'Yield Calculator',
 type: 'analysis',
 desc: Lang.t('yield.subtitle'),
 status: 'online',
 statusLabel: Lang.t('modules.active'),
 onClick: 'BotsModule.openYieldBot()',
 actions: `<button class="btn btn-ghost btn-sm">${Lang.t('yield.launch')}</button>`,
 selected: false,
 sharedWithYou: false,
 }) : '';

 // Bond Scanner virtual card
 const scannerBotCard = canSeeScanner ? buildBotCard({
 icon: 'SCN',
 name: 'Bond Scanner',
 type: 'analysis',
 desc: Lang.t('scanner.subtitle'),
 status: 'online',
 statusLabel: Lang.t('modules.active'),
 onClick: 'BotsModule.openBondScanner()',
 actions: `<button class="btn btn-ghost btn-sm">${Lang.t('scanner.launch')}</button>`,
 selected: false,
 sharedWithYou: false,
 }) : '';

 // MC Agent virtual card (admin-only — feature d'entrainement staff)
 const canSeeMCAgent = u && (u.is_admin || u.role === 'rectester');
 const mcAgentCard = canSeeMCAgent ? buildBotCard({
 icon: 'MCA',
 name: 'MC Agent',
 type: 'gaming',
 desc: Lang.t('mcagent.desc'),
 status: '',
 statusLabel: Lang.t('mcagent.training'),
 onClick: 'BotsModule.openMCAgent()',
 actions: `<button class="btn btn-ghost btn-sm">${Lang.t('mcagent.open')}</button>`,
 selected: false,
 sharedWithYou: false,
 }) : '';

        // AI Harvester virtual card (admin-only — R&D scraping + API privée)
        const canSeeHarvester = u && u.is_admin;
        const harvesterCard = canSeeHarvester ? buildBotCard({
            icon: 'HRV',
            name: 'AI Harvester',
            type: 'data',
            desc: Lang.t('harvester.desc'),
            status: 'online',
            statusLabel: Lang.t('modules.active'),
            onClick: 'BotsModule.openHarvester()',
            actions: `<button class="btn btn-ghost btn-sm">${Lang.t('harvester.launch')}</button>`,
            selected: false,
            sharedWithYou: false,
        }) : '';

        // Oracle virtual card (admin-only — Polymarket × Deribit, monitoring)
        const canSeeOracle = u && u.is_admin;
        const oracleCard = canSeeOracle ? buildBotCard({
            icon: 'ORC',
            name: 'Oracle',
            type: 'trading',
            desc: Lang.t('oracle.desc'),
            status: 'online',
            statusLabel: Lang.t('modules.active'),
            onClick: 'BotsModule.openOracle()',
            actions: `<button class="btn btn-ghost btn-sm">${Lang.t('oracle.open')}</button>`,
            selected: false,
            sharedWithYou: false,
        }) : '';

 if (this._bots.length === 0) {
 grid.innerHTML = `
 ${u && u.role === 'developer' ? `<div class="b-quota-row"><span class="bot-quota-badge">${Lang.t('rbac.bot_quota')}: 0/3</span></div>` : ''}
 <div class="bots-grid-bento">
 ${yieldBotCard}
 ${scannerBotCard}
 ${mcAgentCard}
 ${harvesterCard}
 ${oracleCard}
 </div>`;
 return;
 }

 // Quota for devs
 const quotaHtml = u && u.role === 'developer' ? (() => {
 const ownBots = this._bots.filter(b => b.owner_id === u.id).length;
 const isFull = ownBots >= 3;
 return `<div class="b-quota-row"><span class="bot-quota-badge ${isFull ? 'full' : ''}">${Lang.t('rbac.bot_quota')}: ${ownBots}/3</span></div>`;
 })() : '';

 const userBotsHtml = this._bots.map(b => {
 const isOwner = u && (u.is_admin || b.owner_id === u.id);
 const canManage = isOwner || u?.is_admin;
 const statusKey = statusClassMap[b.status] || '';

 const actions = [
 b.status === 'running'
 ? `<button class="btn btn-ghost btn-sm danger-action" onclick="event.stopPropagation();BotsModule.stopBot(${b.id})">Stop</button>`
 : `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();BotsModule.startBot(${b.id})">Start</button>`,
 canManage ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();BotsModule.openEditor(${b.id})">Code</button>` : '',
 canManage ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();BotsModule.showScheduler(${b.id})">${Lang.t('bots.schedule')}</button>` : '',
 isOwner ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();SharingModal.open(${b.id},'bot')" title="${Lang.t('sharing.title')}">${(Lang.t('sharing.share_btn')||'').startsWith('sharing.') ? 'Share' : Lang.t('sharing.share_btn')}</button>` : '',
 isOwner ? `<button class="btn btn-ghost btn-sm danger-action" onclick="event.stopPropagation();BotsModule.deleteBot(${b.id})">${(Lang.t('common.delete')||'').startsWith('common.') ? 'Del' : Lang.t('common.delete')}</button>` : '',
 ].filter(Boolean).join('');

 return buildBotCard({
 icon: typeTickers[b.bot_type] || 'BOT',
 name: b.name,
 type: b.bot_type,
 desc: b.description || Lang.t('bots.no_desc'),
 status: statusKey,
 statusLabel: statusLabels[b.status] || b.status,
 onClick: `BotsModule.selectBot(${b.id})`,
 actions,
 selected: this._selectedBot?.id === b.id,
 sharedWithYou: !isOwner,
 });
 }).join('');

 grid.innerHTML = `
 ${quotaHtml}
 <div class="bots-grid-bento">
 ${yieldBotCard}
 ${scannerBotCard}
 ${mcAgentCard}
 ${harvesterCard}
 ${oracleCard}
 ${userBotsHtml}
 </div>`;
 },

 showCreateForm() {
 const form = document.getElementById('bot-create-form');
 if (!form) return;
 form.style.display = 'block';
 form.innerHTML = `
 <div class="card"><h3 style="margin:0 0 16px;">${Lang.t('bots.create')}</h3><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;"><div><label class="form-label">${Lang.t('bots.name')}</label><input id="bot-name" class="form-input" placeholder="Mon bot trading" /></div><div><label class="form-label">Type</label><select id="bot-type" class="form-input"><option value="custom">Custom</option><option value="trading">Trading</option><option value="gaming">Gaming</option><option value="scraper">Scraper</option><option value="analysis">${Lang.t('bots.analysis')}</option></select></div><div><label class="form-label">Description</label><input id="bot-desc" class="form-input" placeholder="Ce bot fait..." /></div></div><div style="display:flex;gap:8px;align-items:center;"><button class="btn btn-primary" onclick="BotsModule.createBot()">${Lang.t('common.save')}</button><button class="btn btn-secondary" onclick="document.getElementById('bot-create-form').style.display='none'">${Lang.t('common.cancel')}</button><span id="bot-create-msg" style="font-size:13px;"></span></div></div>`;
 },

 async createBot() {
 const name = document.getElementById('bot-name')?.value?.trim();
 const type = document.getElementById('bot-type')?.value || 'custom';
 const desc = document.getElementById('bot-desc')?.value?.trim() || '';
 const msg = document.getElementById('bot-create-msg');

 if (!name) { if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = Lang.t('bots.name_required'); } return; }

 const r = await Auth.apiCall('/api/bots', {
 method: 'POST',
 body: JSON.stringify({ name, bot_type: type, description: desc })
 });

 if (r && r.ok) {
 document.getElementById('bot-create-form').style.display = 'none';
 await this.loadBots();
 } else {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
 }
 },

 async startBot(id) {
 const r = await Auth.apiCall(`/api/bots/${id}/start`, { method: 'POST' });
 if (r && r.ok) {
 await this.loadBots();
 } else {
 const err = r ? await r.json().catch(() => ({})) : {};
 if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
 else alert(`${err.detail || Lang.t('common.error')}`);
 }
 },

 async stopBot(id) {
 const r = await Auth.apiCall(`/api/bots/${id}/stop`, { method: 'POST' });
 if (r && r.ok) await this.loadBots();
 },

 async deleteBot(id) {
 if (!confirm(Lang.t('bots.delete_confirm'))) return;
 const r = await Auth.apiCall(`/api/bots/${id}`, { method: 'DELETE' });
 if (r && r.ok) {
 this._selectedBot = null;
 document.getElementById('bot-detail').style.display = 'none';
 await this.loadBots();
 }
 },

 async selectBot(id) {
 this._selectedBot = this._bots.find(b => b.id === id);
 this._renderGrid();
 await this.showBotDetail(id);
 },

 async showBotDetail(id) {
 const detail = document.getElementById('bot-detail');
 if (!detail) return;
 detail.style.display = 'block';

 // Charger les logs
 const lr = await Auth.apiCall(`/api/bots/${id}/logs`);
 const logs = lr && lr.ok ? await lr.json() : { logs: [] };
 const bot = this._bots.find(b => b.id === id);

 detail.innerHTML = `
 <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">${Lang.t('bots.logs')} — ${bot?.name || 'Bot'}</h3><div style="display:flex;gap:8px;align-items:center;"><span style="font-size:11px;color:var(--text-muted);">${logs.logs.length} ${Lang.t('bots.lines')}</span><button class="btn btn-secondary btn-sm" onclick="BotsModule.showBotDetail(${id})">${Lang.t('common.refresh')}</button></div></div><div id="bot-logs-terminal" style="background:#0d1117;border-radius:8px;padding:12px;max-height:350px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;">
 ${logs.logs.length > 0 
 ? logs.logs.map((l, i) => `<div style="display:flex;gap:8px;"><span style="color:#6b7280;min-width:28px;text-align:right;user-select:none;">${i+1}</span><span>${l.replace(/</g,'&lt;')}</span></div>`).join('')
 : `<div style="color:#6b7280;text-align:center;padding:20px;">${Lang.t('bots.no_logs')}</div>`
 }
 </div></div>`;
 // Auto-scroll vers le bas
 const terminal = document.getElementById('bot-logs-terminal');
 if (terminal) terminal.scrollTop = terminal.scrollHeight;
 },

 // ============ SCHEDULER ============

 async showScheduler(botId) {
 const detail = document.getElementById('bot-detail');
 if (!detail) return;
 detail.style.display = 'block';

 const bot = this._bots.find(b => b.id === botId);
 const botName = bot?.name || 'Bot';

 // Charger les tâches planifiées du bot
 const tr = await Auth.apiCall(`/api/scheduler/bot/${botId}`);
 const tasks = (tr && tr.ok) ? await tr.json() : [];
 const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);

 const taskLabels = {
 bot_start: Lang.t('scheduler.bot_start'),
 bot_stop: Lang.t('scheduler.bot_stop'),
 bot_restart: Lang.t('scheduler.bot_restart'),
 };

 detail.innerHTML = `
 <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"><h3 style="margin:0;">${Lang.t('bots.schedule')} — ${botName}</h3><button class="btn btn-secondary btn-sm" onclick="document.getElementById('bot-detail').style.display='none'">${Lang.t('common.close')}</button></div><!-- Formulaire nouvelle tâche --><div style="background:var(--bg-elev-3);border-radius:8px;padding:14px;margin-bottom:16px;border:1px solid var(--border);"><div style="font-size:13px;font-weight:600;margin-bottom:10px;">${Lang.t('bots.new_sched_task')}</div><div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;"><div style="flex:1;min-width:140px;"><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.type')}</label><select id="bot-sched-type" class="form-input" style="margin-top:4px;"><option value="bot_start">${Lang.t('scheduler.bot_start')}</option><option value="bot_stop">${Lang.t('scheduler.bot_stop')}</option><option value="bot_restart">${Lang.t('scheduler.bot_restart')}</option></select></div><div style="flex:1;min-width:110px;"><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.mode')}</label><select id="bot-sched-mode" class="form-input" style="margin-top:4px;" onchange="BotsModule._onBotSchedModeChange()"><option value="interval">${Lang.t('scheduler.mode_interval')}</option><option value="fixed">${Lang.t('scheduler.mode_fixed')}</option></select></div></div><!-- Mode intervalle --><div id="bot-sched-interval-row" style="display:flex;gap:8px;align-items:flex-end;margin-top:8px;"><div style="flex:1;min-width:100px;"><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.interval')}</label><select id="bot-sched-interval" class="form-input" style="margin-top:4px;"><option value="1">1h</option><option value="3">3h</option><option value="6" selected>6h</option><option value="12">12h</option><option value="24">24h</option><option value="48">48h</option><option value="168">${Lang.t('scheduler.week')}</option></select></div><button class="btn btn-primary" onclick="BotsModule.createBotTask(${botId})">${Lang.t('scheduler.add')}</button></div><!-- Mode heure fixe --><div id="bot-sched-fixed-row" style="display:none;margin-top:8px;"><div style="display:flex;gap:8px;align-items:flex-end;"><div><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.time')}</label><input type="time" id="bot-sched-time" class="form-input" style="margin-top:4px;" value="08:00" /></div><button class="btn btn-primary" onclick="BotsModule.createBotTask(${botId})">${Lang.t('scheduler.add')}</button></div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;"><label style="font-size:12px;color:var(--text-muted);margin-right:4px;">${Lang.t('scheduler.days')}:</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="bot-day-daily" checked onchange="BotsModule._onBotDailyToggle(this)"> ${Lang.t('scheduler.daily')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="mon" disabled> ${Lang.t('scheduler.day_mon')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="tue" disabled> ${Lang.t('scheduler.day_tue')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="wed" disabled> ${Lang.t('scheduler.day_wed')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="thu" disabled> ${Lang.t('scheduler.day_thu')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="fri" disabled> ${Lang.t('scheduler.day_fri')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="sat" disabled> ${Lang.t('scheduler.day_sat')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="sun" disabled> ${Lang.t('scheduler.day_sun')}</label></div></div><div id="bot-sched-msg" style="font-size:12px;margin-top:8px;"></div></div><!-- Liste des tâches -->
 ${taskList.length === 0 ? `
 <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
 
 ${Lang.t('bots.no_sched_tasks')}
 </div>
 ` : `
 <div style="display:flex;flex-direction:column;gap:6px;">
 ${taskList.map(t => {
 const locale = Lang.t('common.locale') || 'fr-FR';
 return `
 <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-elev-3);border-radius:8px;border:1px solid var(--border);"><span style="font-size:18px;">${taskLabels[t.task_type] || 'Task'}</span><div style="flex:1;"><div style="font-size:13px;font-weight:600;">${taskLabels[t.task_type] || t.task_type}</div><div style="font-size:11px;color:var(--text-muted);">
 ${t.schedule_time ? ('' + Lang.t('scheduler.at') + ' ' + t.schedule_time + ' (' + (t.schedule_days || 'daily') + ')') : ('' + Lang.t('scheduler.every') + ' ' + t.interval_hours + 'h')}
 ${t.next_run ? ` · ${Lang.t('bots.next_run')}: ${new Date(t.next_run).toLocaleString(locale)}` : ''}
 ${t.last_run ? ` · ${Lang.t('bots.last_run')}: ${new Date(t.last_run).toLocaleString(locale)}` : ''}
 </div></div><div style="display:flex;gap:6px;align-items:center;"><span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${t.enabled ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.05)'};color:${t.enabled ? 'var(--accent)' : 'var(--text-muted)'};">
 ${t.enabled ? ' ' + Lang.t('scheduler.active') : ' ' + Lang.t('scheduler.inactive')}
 </span><button class="btn btn-sm btn-secondary" onclick="BotsModule.toggleBotTask(${t.id}, ${botId})" title="${t.enabled ? 'Pause' : 'Resume'}">${t.enabled ? 'Pause' : 'Resume'}</button><button class="btn btn-sm btn-secondary" onclick="BotsModule.deleteBotTask(${t.id}, ${botId})" style="color:var(--danger);" title="Delete">Del</button></div></div>`;
 }).join('')}
 </div>
 `}
 </div>`;
 },

 _onBotSchedModeChange() {
 const mode = document.getElementById('bot-sched-mode')?.value || 'interval';
 const intRow = document.getElementById('bot-sched-interval-row');
 const fixRow = document.getElementById('bot-sched-fixed-row');
 if (intRow) intRow.style.display = mode === 'interval' ? 'flex' : 'none';
 if (fixRow) fixRow.style.display = mode === 'fixed' ? 'block' : 'none';
 },

 _onBotDailyToggle(cb) {
 document.querySelectorAll('.bot-day-check').forEach(c => { c.disabled = cb.checked; if (cb.checked) c.checked = false; });
 },

 async createBotTask(botId) {
 const taskType = document.getElementById('bot-sched-type')?.value;
 const mode = document.getElementById('bot-sched-mode')?.value || 'interval';
 const msg = document.getElementById('bot-sched-msg');

 const body = { bot_id: botId, task_type: taskType };

 if (mode === 'fixed') {
 body.schedule_time = document.getElementById('bot-sched-time')?.value || '08:00';
 const dailyCb = document.getElementById('bot-day-daily');
 if (dailyCb && dailyCb.checked) {
 body.schedule_days = 'daily';
 } else {
 const checked = [...document.querySelectorAll('.bot-day-check:checked')].map(c => c.value);
 body.schedule_days = checked.length > 0 ? checked.join(',') : 'daily';
 }
 } else {
 body.interval_hours = parseInt(document.getElementById('bot-sched-interval')?.value) || 6;
 }

 const r = await Auth.apiCall('/api/scheduler/', {
 method: 'POST',
 body: JSON.stringify(body)
 });

 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('scheduler.created'); }
 setTimeout(() => this.showScheduler(botId), 500);
 } else {
 const err = r ? await r.json().catch(() => ({})) : {};
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
 }
 },

 async toggleBotTask(taskId, botId) {
 await Auth.apiCall(`/api/scheduler/${taskId}/toggle`, { method: 'POST' });
 await this.showScheduler(botId);
 },

 async deleteBotTask(taskId, botId) {
 if (!confirm(Lang.t('bots.delete_task_confirm'))) return;
 await Auth.apiCall(`/api/scheduler/${taskId}`, { method: 'DELETE' });
 await this.showScheduler(botId);
 },

 // ============ CODE EDITOR ============

 async openEditor(id) {
 const detail = document.getElementById('bot-detail');
 if (!detail) return;
 detail.style.display = 'block';

 const cr = await Auth.apiCall(`/api/bots/${id}/code`);
 const data = cr && cr.ok ? await cr.json() : { code: '' };
 const bot = this._bots.find(b => b.id === id);

 detail.innerHTML = `
 <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">${Lang.t('bots.editor')} — ${bot?.name || 'Bot'}</h3><div style="display:flex;gap:8px;align-items:center;"><span style="font-size:11px;color:var(--text-muted);">${Lang.t('bots.save_hint')}</span><span id="code-save-msg" style="font-size:12px;"></span><button class="btn btn-primary btn-sm" onclick="BotsModule.saveCode(${id})">${Lang.t('common.save')}</button></div></div><textarea id="bot-code-editor" spellcheck="false" style="width:100%;min-height:400px;background:#0d1117;color:#c9d1d9;border:1px solid var(--border);border-radius:8px;padding:16px;font-family:'Fira Code',monospace;font-size:13px;line-height:1.6;resize:vertical;tab-size:4;outline:none;">${data.code.replace(/</g,'&lt;')}</textarea></div>`;
 // Support Tab dans l'éditeur
 const editor = document.getElementById('bot-code-editor');
 if (editor) {
 editor.addEventListener('keydown', (e) => {
 if (e.key === 'Tab') {
 e.preventDefault();
 const start = editor.selectionStart;
 const end = editor.selectionEnd;
 editor.value = editor.value.substring(0, start) + ' ' + editor.value.substring(end);
 editor.selectionStart = editor.selectionEnd = start + 4;
 }
 if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
 e.preventDefault();
 BotsModule.saveCode(id);
 }
 });
 editor.focus();
 }
 },

 async saveCode(id) {
 const code = document.getElementById('bot-code-editor')?.value || '';
 const msg = document.getElementById('code-save-msg');
 if (msg) { msg.style.color = 'var(--info)'; msg.textContent = '⏳...'; }

 const r = await Auth.apiCall(`/api/bots/${id}/code`, {
 method: 'PUT',
 body: JSON.stringify({ code })
 });

 if (r && r.ok) {
 if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('bots.saved'); }
 } else {
 if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
 }
 },

 // ============ YIELD BOT ============

 _yieldState: {
 jobId: null,
 file: null,
 mode: 'recalculate',
 status: null,
 pollInterval: null,
 usage: null,
 priceThreshold: 101,
 },

 async openYieldBot() {
 // Arrêter le refresh auto des bots
 if (this._refreshInterval) {
 clearInterval(this._refreshInterval);
 this._refreshInterval = null;
 }

 const content = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!content) return;

 // Vérifier s'il y a un job actif avant de réinitialiser
 try {
 const r = await Auth.apiCall('/api/bots/yield/active');
 if (r && r.ok) {
 const data = await r.json();
 if (data.found) {
 // Reconnexion automatique au job existant
 this._yieldState.jobId = data.job_id;
 this._yieldState.mode = data.mode || 'all';
 this._yieldState.status = data.status;
 this._yieldState.file = { name: data.filename };

 if (data.status === 'running') {
 // Le bot tourne encore — reprendre le suivi en direct
 this._renderYieldRunning();
 Toast.success(Lang.t('yield.reconnected'));
 return;
 } else if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
 // Job terminé récemment — afficher les résultats
 this._yieldState.resultFile = data.result_file || null;
 this._yieldState.processedCount = data.processed || 0;
 this._renderYieldCompleted(data);
 Toast.info(Lang.t('yield.recovered'));
 return;
 }
 }
 }
 } catch (e) {
 console.warn('[YieldBot] Pas de job actif:', e);
 }

 // Aucun job actif — afficher l'écran d'upload normal
 this._yieldState.jobId = null;
 this._yieldState.file = null;
 this._yieldState.status = null;

 // Charger l'usage
 await this._loadYieldUsage();

 this._renderYieldUpload(content);
 },

 async _loadYieldUsage() {
 try {
 const r = await Auth.apiCall('/api/bots/yield/usage');
 if (r && r.ok) {
 this._yieldState.usage = await r.json();
 }
 } catch (e) {
 this._yieldState.usage = { today_runs: 0, max_runs: 5, remaining: 5 };
 }
 },

 _renderYieldUpload(container) {
 if (!container) container = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!container) return;

 const usage = this._yieldState.usage || { today_runs: 0, max_runs: 5, remaining: 5 };
 const usageClass = usage.remaining === 0 ? 'danger' : usage.remaining <= 2 ? 'warning' : '';
 const hasFile = this._yieldState.file !== null;
 const adminUser = Auth.getUser();
 const isAdmin = adminUser && adminUser.is_admin;

 container.innerHTML = `
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">YLD</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('yield.subtitle')}</p></div></div><div style="display:flex;gap:8px;align-items:center;"><span class="yield-usage-badge ${usageClass}">
 ${Lang.t('yield.usage')}: ${usage.today_runs}/${usage.max_runs}
 </span><button class="btn btn-secondary btn-sm" onclick="BotsModule.render(BotsModule._container)">
 ${Lang.t('yield.back_bots')}
 </button></div></div><div class="card" style="margin-bottom:20px;"><!-- Dropzone --><div id="yield-dropzone" class="yield-dropzone ${hasFile ? 'has-file' : ''}"
 ondragover="event.preventDefault();this.classList.add('dragover')"
 ondragleave="this.classList.remove('dragover')"
 ondrop="event.preventDefault();this.classList.remove('dragover');BotsModule._onYieldFileDrop(event)"
 onclick="document.getElementById('yield-file-input').click()">
 ${hasFile ? this._renderYieldFileInfo() : `
 <span class="yield-dropzone-icon"></span><div class="yield-dropzone-text">${Lang.t('yield.upload_hint')}</div>
 `}
 </div><input type="file" id="yield-file-input" accept=".xlsx" style="display:none"
 onchange="BotsModule._onYieldFileSelect(event)"><!-- Mode selector --><div class="yield-modes"><div class="yield-mode-option ${this._yieldState.mode === 'recalculate' ? 'selected' : ''}"
 onclick="BotsModule._selectYieldMode('recalculate')"><div class="yield-mode-label">${Lang.t('yield.mode_recalculate')}</div><div class="yield-mode-desc">${Lang.t('yield.mode_recalculate_desc')}</div></div><div class="yield-mode-option ${this._yieldState.mode === 'all' ? 'selected' : ''}"
 onclick="BotsModule._selectYieldMode('all')"><div class="yield-mode-label">${Lang.t('yield.mode_all')}</div><div class="yield-mode-desc">${Lang.t('yield.mode_all_desc')}</div></div></div><!-- Seuil prix coloration --><div class="yield-threshold-container" style="margin-top:14px;padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><label style="font-size:13px;font-weight:600;"> ${Lang.t('yield.threshold_label') || 'Seuil coloration prix'}</label><span id="yield-threshold-value" style="font-size:14px;font-weight:700;color:var(--info);min-width:40px;text-align:right;">${this._yieldState.priceThreshold}</span></div><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;color:var(--text-muted);">90</span><input type="range" id="yield-threshold-slider" min="90" max="110" step="0.5" value="${this._yieldState.priceThreshold}"
 style="flex:1;accent-color:var(--info);cursor:pointer;"
 oninput="BotsModule._onThresholdChange(this.value)"><span style="font-size:11px;color:var(--text-muted);">110</span></div><div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
 ${Lang.t('yield.threshold_above') || 'Rouge si prix'} &gt; <span id="yield-threshold-hint">${this._yieldState.priceThreshold}</span> · ${Lang.t('yield.threshold_below') || 'Noir si prix'} ≤ <span id="yield-threshold-hint2">${this._yieldState.priceThreshold}</span></div></div><!-- Upload info / summary --><div id="yield-upload-info" style="display:none;margin-top:12px;"></div><!-- Launch button --><button id="yield-launch-btn" class="yield-launch-btn" onclick="BotsModule._launchYieldBot()"
 ${!hasFile ? 'disabled' : ''}>
 ${Lang.t('yield.launch')}
 </button><div id="yield-error-msg" style="display:none;margin-top:12px;color:var(--danger);font-size:13px;text-align:center;"></div></div> `;

 },

 // ================================================================
 //  Rating fetcher key management (admin only)
 // ================================================================

 async _loadRatingKeyStatus() {
   const statusEl = document.getElementById('yield-rating-key-status');
   const actionsEl = document.getElementById('yield-rating-key-actions');
   if (!statusEl || !actionsEl) return;
   try {
     const resp = await Auth.apiCall('/api/bots/yield/settings/rating-key');
     if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
     const data = await resp.json();
     if (data.has_key) {
       const srcLabel = data.source === 'env_var'
         ? (Lang.t('yield.config_source_env') || 'variable d\'environnement (système)')
         : (Lang.t('yield.config_source_file') || 'fichier sécurisé');
       statusEl.innerHTML = `<span style="color:var(--accent);">✓</span> <strong style="color:var(--text);">${data.preview}</strong> <span style="color:var(--text-dim);">· ${srcLabel}</span>`;
       actionsEl.innerHTML = data.source === 'file'
         ? `<button class="btn btn-secondary btn-sm" onclick="BotsModule._showRatingKeyEdit()">${Lang.t('yield.config_change') || 'Changer la clé'}</button>
            <button class="btn btn-danger btn-sm" onclick="BotsModule._deleteRatingKey()">${Lang.t('yield.config_delete') || 'Supprimer'}</button>`
         : `<div style="font-size:11px;color:var(--text-dim);">${Lang.t('yield.config_env_locked') || 'Clé fournie par l\'environnement système — utiliser SSH pour la modifier.'}</div>`;
     } else {
       statusEl.innerHTML = `<span style="color:var(--warning);">∅</span> <span style="color:var(--text-muted);">${Lang.t('yield.config_no_key') || 'Aucune clé configurée — le rating fetcher est désactivé.'}</span>`;
       actionsEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="BotsModule._showRatingKeyEdit()">${Lang.t('yield.config_set') || 'Configurer la clé'}</button>`;
     }
   } catch (e) {
     statusEl.innerHTML = `<span style="color:var(--danger);">✗</span> <span style="color:var(--text-muted);">${Lang.t('yield.config_load_error') || 'Erreur de chargement'} (${esc(e.message)})</span>`;
     actionsEl.innerHTML = '';
   }
 },

 _showRatingKeyEdit() {
   const form = document.getElementById('yield-rating-key-form');
   const actions = document.getElementById('yield-rating-key-actions');
   if (form) form.style.display = 'block';
   if (actions) actions.style.display = 'none';
   const input = document.getElementById('yield-rating-key-input');
   if (input) { input.value = ''; input.focus(); }
 },

 _cancelRatingKeyEdit() {
   const form = document.getElementById('yield-rating-key-form');
   const actions = document.getElementById('yield-rating-key-actions');
   if (form) form.style.display = 'none';
   if (actions) actions.style.display = 'flex';
 },

 async _saveRatingKey() {
   const input = document.getElementById('yield-rating-key-input');
   const key = (input?.value || '').trim();
   if (!key) {
     Toast?.warning(Lang.t('yield.config_key_empty') || 'La clé est vide');
     return;
   }
   try {
     const resp = await Auth.apiCall('/api/bots/yield/settings/rating-key', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ key }),
     });
     const data = await resp.json();
     if (!resp.ok) {
       Toast?.error(data.detail || `HTTP ${resp.status}`);
       return;
     }
     Toast?.success(data.message || (Lang.t('yield.config_saved') || 'Clé enregistrée'));
     this._cancelRatingKeyEdit();
     this._loadRatingKeyStatus();
   } catch (e) {
     Toast?.error((Lang.t('yield.config_save_error') || 'Erreur sauvegarde') + ': ' + e.message);
   }
 },

 async _deleteRatingKey() {
   const ok = confirm(Lang.t('yield.config_delete_confirm') || 'Supprimer la clé Brave Search ? Le rating fetcher sera désactivé.');
   if (!ok) return;
   try {
     const resp = await Auth.apiCall('/api/bots/yield/settings/rating-key', { method: 'DELETE' });
     const data = await resp.json();
     if (!resp.ok) {
       Toast?.error(data.detail || `HTTP ${resp.status}`);
       return;
     }
     Toast?.success(data.message || (Lang.t('yield.config_deleted') || 'Clé supprimée'));
     this._loadRatingKeyStatus();
   } catch (e) {
     Toast?.error((Lang.t('yield.config_delete_error') || 'Erreur suppression') + ': ' + e.message);
   }
 },

 _renderYieldFileInfo() {
 const f = this._yieldState.file;
 if (!f) return '';
 const sizeKB = (f.size / 1024).toFixed(1);
 return `
 <div class="yield-file-info"><span class="b-ticker">XLS</span><div class="yield-file-details"><div class="yield-file-name">${esc(f.name)}</div><div class="yield-file-meta">${sizeKB} KB</div></div><button class="yield-file-remove" onclick="event.stopPropagation();BotsModule._removeYieldFile()">${Lang.t('nodes.remove')}</button></div>
 `;
 },

 _onYieldFileDrop(event) {
 const files = event.dataTransfer?.files;
 if (files && files.length > 0) {
 this._handleYieldFile(files[0]);
 }
 },

 _onYieldFileSelect(event) {
 const files = event.target?.files;
 if (files && files.length > 0) {
 this._handleYieldFile(files[0]);
 }
 },

 _handleYieldFile(file) {
 if (!file.name.endsWith('.xlsx')) {
 const errMsg = document.getElementById('yield-error-msg');
 if (errMsg) {
 errMsg.style.display = 'block';
 errMsg.textContent = Lang.t('yield.invalid_file');
 }
 return;
 }

 this._yieldState.file = file;

 // Mettre à jour la dropzone
 const dropzone = document.getElementById('yield-dropzone');
 if (dropzone) {
 dropzone.classList.add('has-file');
 dropzone.innerHTML = this._renderYieldFileInfo();
 }

 // Activer le bouton
 const btn = document.getElementById('yield-launch-btn');
 if (btn) btn.disabled = false;

 // Cacher l'erreur
 const errMsg = document.getElementById('yield-error-msg');
 if (errMsg) errMsg.style.display = 'none';
 },

 _removeYieldFile() {
 this._yieldState.file = null;
 const dropzone = document.getElementById('yield-dropzone');
 if (dropzone) {
 dropzone.classList.remove('has-file');
 dropzone.innerHTML = `
 <span class="yield-dropzone-icon"></span><div class="yield-dropzone-text">${Lang.t('yield.upload_hint')}</div>
 `;
 }
 const btn = document.getElementById('yield-launch-btn');
 if (btn) btn.disabled = true;

 // Reset file input
 const input = document.getElementById('yield-file-input');
 if (input) input.value = '';
 },

 _selectYieldMode(mode) {
 this._yieldState.mode = mode;
 document.querySelectorAll('.yield-mode-option').forEach(el => {
 el.classList.toggle('selected', el.textContent.includes(
 ''
 ));
 });
 // Re-select properly via onclick attribute content
 const modes = document.querySelectorAll('.yield-mode-option');
 modes.forEach(el => el.classList.remove('selected'));
 if (mode === 'recalculate') modes[0]?.classList.add('selected');
 else modes[1]?.classList.add('selected');
 },

 _onThresholdChange(value) {
 this._yieldState.priceThreshold = parseFloat(value);
 const valEl = document.getElementById('yield-threshold-value');
 const hintEl = document.getElementById('yield-threshold-hint');
 const hint2El = document.getElementById('yield-threshold-hint2');
 if (valEl) valEl.textContent = value;
 if (hintEl) hintEl.textContent = value;
 if (hint2El) hint2El.textContent = value;
 },

 async _launchYieldBot() {
 const file = this._yieldState.file;
 if (!file) return;

 const btn = document.getElementById('yield-launch-btn');
 if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }

 const errMsg = document.getElementById('yield-error-msg');
 if (errMsg) errMsg.style.display = 'none';

 try {
 // 1. Upload le fichier
 const formData = new FormData();
 formData.append('file', file);

 const uploadR = await Auth.apiCall('/api/bots/yield/upload', {
 method: 'POST',
 body: formData,
 headers: {}, // Let browser set content-type with boundary
 rawBody: true,
 });

 if (!uploadR || !uploadR.ok) {
 const err = uploadR ? await uploadR.json().catch(() => ({})) : {};
 throw new Error(err.detail || 'Upload failed');
 }

 const uploadData = await uploadR.json();
 this._yieldState.jobId = uploadData.job_id;

 // 2. Lancer le bot
 const runR = await Auth.apiCall(`/api/bots/yield/run/${uploadData.job_id}`, {
 method: 'POST',
 body: JSON.stringify({
 mode: this._yieldState.mode,
 price_threshold: this._yieldState.priceThreshold || 101,
 }),
 });

 if (!runR || !runR.ok) {
 const err = runR ? await runR.json().catch(() => ({})) : {};
 throw new Error(err.detail || 'Run failed');
 }

 // 3. Passer à l'écran de suivi
 this._yieldState.status = 'running';
 this._renderYieldRunning();

 } catch (e) {
 if (btn) { btn.disabled = false; btn.textContent = Lang.t('yield.launch'); }
 if (errMsg) {
 errMsg.style.display = 'block';
 errMsg.textContent = `${e.message}`;
 }
 }
 },

 _renderYieldRunning() {
 const container = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!container) return;

 const mode = this._yieldState.mode;
 const modeLabel = mode === 'all' ? Lang.t('yield.mode_all') : Lang.t('yield.mode_recalculate');

 container.innerHTML = `
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">YLD</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')} — <span class="yield-pulse"></span>${Lang.t('yield.running')}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${this._yieldState.file?.name || ''} · ${modeLabel}</p></div></div></div><div class="card" style="margin-bottom:16px;"><!-- Progress --><div class="yield-progress-container"><div class="yield-progress-bar"><div id="yield-progress-fill" class="yield-progress-fill" style="width:0%"></div></div><div class="yield-progress-text"><span id="yield-progress-label">${Lang.t('yield.processing')} 0/0</span><span id="yield-progress-percent" class="yield-progress-percent">0%</span></div></div><!-- Stats (mis à jour en live) --><div class="yield-stats"><div class="yield-stat-card success"><div id="yield-stat-updated" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('yield.updated')}</div></div><div class="yield-stat-card warning"><div id="yield-stat-skipped" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('yield.skipped')}</div></div><div class="yield-stat-card error"><div id="yield-stat-errors" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('yield.errors')}</div></div></div></div><!-- Logs terminal --><div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">${Lang.t('yield.logs')}</h3>
 ${mode === 'all' ? `<button class="btn btn-danger btn-sm" onclick="BotsModule._stopYieldBot()">${Lang.t('yield.stop')}</button>` : ''}
 </div><div id="yield-logs" class="yield-terminal"><div style="color:#6b7280;text-align:center;padding:20px;">⏳ ${Lang.t('yield.running')}</div></div></div>
 `;

 // Démarrer le polling
 this._startYieldPolling();
 },

 _startYieldPolling() {
 // Nettoyer l'ancien polling
 if (this._yieldState.pollInterval) {
 clearInterval(this._yieldState.pollInterval);
 }

 // Poll immédiatement puis toutes les 2 secondes
 this._pollYieldStatus();
 this._yieldState.pollInterval = setInterval(() => this._pollYieldStatus(), 2000);
 },

 async _pollYieldStatus() {
 const jobId = this._yieldState.jobId;
 if (!jobId) return;

 try {
 const r = await Auth.apiCall(`/api/bots/yield/status/${jobId}`);
 if (!r || !r.ok) return;

 const data = await r.json();

 // Mettre à jour la progression
 const fill = document.getElementById('yield-progress-fill');
 const label = document.getElementById('yield-progress-label');
 const pct = document.getElementById('yield-progress-percent');

 if (fill) fill.style.width = `${data.progress_percent}%`;
 if (label) label.textContent = `${Lang.t('yield.processing')} ${data.progress}`;
 if (pct) pct.textContent = `${data.progress_percent}%`;

 // Mettre à jour les stats
 const statUpdated = document.getElementById('yield-stat-updated');
 const statSkipped = document.getElementById('yield-stat-skipped');
 const statErrors = document.getElementById('yield-stat-errors');
 if (statUpdated) statUpdated.textContent = data.stats?.updated || 0;
 if (statSkipped) statSkipped.textContent = data.stats?.skipped || 0;
 if (statErrors) statErrors.textContent = data.stats?.errors || 0;

 // Mettre à jour les logs
 const logsEl = document.getElementById('yield-logs');
 if (logsEl && data.logs && data.logs.length > 0) {
 logsEl.innerHTML = data.logs.map((l, i) => `
 <div class="yield-log-line"><span class="yield-log-num">${i + 1}</span><span class="yield-log-content">${l.replace(/</g, '&lt;')}</span></div>
 `).join('');
 // Auto-scroll en bas
 logsEl.scrollTop = logsEl.scrollHeight;
 }

 // Vérifier si terminé
 if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
 this._yieldState.status = data.status;
 this._yieldState.resultFile = data.result_file || null;
 this._yieldState.processedCount = data.processed || 0;
 clearInterval(this._yieldState.pollInterval);
 this._yieldState.pollInterval = null;

 // Attendre un petit moment pour que les derniers logs arrivent
 setTimeout(() => this._renderYieldCompleted(data), 1000);
 }

 } catch (e) {
 console.error('[YieldBot] Poll error:', e);
 }
 },

 _renderYieldCompleted(data) {
 const container = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!container) return;

 const isSuccess = data.status === 'completed';
 const statusIcon = isSuccess ? 'OK' : data.status === 'error' ? 'ERR' : 'STOP';
 const statusLabel = isSuccess ? Lang.t('yield.completed') : data.status === 'error' ? Lang.t('yield.error') : Lang.t('yield.stopped');

 container.innerHTML = `
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">YLD</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')} — ${statusIcon} ${statusLabel}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${esc(data.filename || '')}</p></div></div></div><!-- Stats résumé --><div class="card" style="margin-bottom:16px;"><h3 style="margin:0 0 16px;">${Lang.t('yield.summary')}</h3><div class="yield-stats"><div class="yield-stat-card success"><div class="yield-stat-value">${data.stats?.updated || 0}</div><div class="yield-stat-label">${Lang.t('yield.updated')}</div></div><div class="yield-stat-card warning"><div class="yield-stat-value">${data.stats?.skipped || 0}</div><div class="yield-stat-label">${Lang.t('yield.skipped')}</div></div><div class="yield-stat-card error"><div class="yield-stat-value">${data.stats?.errors || 0}</div><div class="yield-stat-label">${Lang.t('yield.errors')}</div></div></div><!-- Progress bar complète --><div class="yield-progress-container" style="margin-top:16px;"><div class="yield-progress-bar"><div class="yield-progress-fill" style="width:${data.progress_percent || 0}%;${!isSuccess ? 'background:var(--warning);' : ''}"></div></div><div class="yield-progress-text" style="margin-top:4px;"><span>${esc(data.progress || '')}</span><span class="yield-progress-percent">${data.progress_percent || 0}%</span></div></div><!-- Actions --><div style="display:flex;gap:12px;margin-top:20px;">
 ${isSuccess && data.result_file ? `
 <button class="yield-launch-btn" style="flex:1;margin-top:0;" onclick="BotsModule._downloadYieldResult()">
 ${Lang.t('yield.download')}
 </button>
 ` : ''}
 ${data.status === 'stopped' && this._yieldState.processedCount > 0 ? `
 <button class="yield-launch-btn" style="flex:1;margin-top:0;background:var(--danger);" onclick="BotsModule._resumeYieldBot()">
 ${Lang.t('yield.resume')} (${Lang.t('yield.from_bond')} ${this._yieldState.processedCount + 1})
 </button>
 ` : ''}
 <button class="btn btn-secondary" style="flex:1;padding:14px;font-size:15px;font-weight:600;" onclick="BotsModule._startNewYieldJob()">
 ${Lang.t('yield.restart')}
 </button></div></div><!-- Logs --><div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">${Lang.t('yield.logs')} (${data.logs_count || data.logs?.length || 0} ${Lang.t('bots.lines')})</h3></div><div class="yield-terminal">
 ${data.logs && data.logs.length > 0
 ? data.logs.map((l, i) => `
 <div class="yield-log-line"><span class="yield-log-num">${i + 1}</span><span class="yield-log-content">${l.replace(/</g, '&lt;')}</span></div>
 `).join('')
 : '<div style="color:#6b7280;text-align:center;padding:20px;">No logs</div>'
 }
 </div></div>
 `;
 },

 async _downloadYieldResult() {
 const jobId = this._yieldState.jobId;
 if (!jobId) return;

 try {
 // Méthode 1: fetch + blob pour contrôler le nom du fichier
 const r = await Auth.apiCall(`/api/bots/yield/download/${jobId}`);
 if (!r || !r.ok) {
 throw new Error('Download failed');
 }

 // Déterminer le nom du fichier
 let filename = 'result.xlsx';
 const disposition = r.headers.get('Content-Disposition') || '';
 const match = disposition.match(/filename="?([^";\n]+)"?/i);
 if (match) {
 filename = decodeURIComponent(match[1].trim());
 } else if (this._yieldState.file?.name) {
 const base = this._yieldState.file.name.replace(/\.xlsx$/i, '');
 filename = `${base}_AGGIORNATO.xlsx`;
 }

 // Créer le blob et télécharger
 const blob = await r.blob();
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = filename;
 a.style.display = 'none';
 document.body.appendChild(a);
 a.click();
 // Petit délai avant cleanup pour que le download se lance
 setTimeout(() => {
 document.body.removeChild(a);
 URL.revokeObjectURL(url);
 }, 100);

 } catch (e) {
 console.error('[YieldBot] Download error:', e);
 // Fallback: window.open avec le nom de fichier dans l'URL
 const token = Auth.getToken();
 const fname = this._yieldState.file?.name || 'result.xlsx';
 const outputName = fname.replace(/\.xlsx$/i, '_AGGIORNATO.xlsx');
 if (token) {
 window.open(`/api/bots/yield/download-file/${jobId}/${encodeURIComponent(outputName)}?token=${encodeURIComponent(token)}`, '_blank');
 }
 }
 },

 async _stopYieldBot() {
 const jobId = this._yieldState.jobId;
 if (!jobId) return;

 try {
 await Auth.apiCall(`/api/bots/yield/stop/${jobId}`, { method: 'POST' });
 } catch (e) {
 console.error('[YieldBot] Stop error:', e);
 }
 },

 async _resumeYieldBot() {
 const jobId = this._yieldState.jobId;
 const skip = this._yieldState.processedCount || 0;
 if (!jobId || skip === 0) return;

 try {
 const runR = await Auth.apiCall(`/api/bots/yield/run/${jobId}`, {
 method: 'POST',
 body: JSON.stringify({
 mode: this._yieldState.mode,
 skip: skip,
 price_threshold: this._yieldState.priceThreshold || 101,
 }),
 });

 if (!runR || !runR.ok) {
 const err = runR ? await runR.json().catch(() => ({})) : {};
 throw new Error(err.detail || 'Resume failed');
 }

 this._yieldState.status = 'running';
 this._renderYieldRunning();
 } catch (e) {
 console.error('[YieldBot] Resume error:', e);
 Toast.error(`Resume failed: ${e.message}`);
 }
 },

 /**
 * Démarrer un nouveau job — réinitialise l'état et affiche l'écran d'upload.
 * Utilisé quand l'utilisateur veut explicitement relancer avec un autre fichier.
 */
 async _startNewYieldJob() {
 this._yieldState.jobId = null;
 this._yieldState.file = null;
 this._yieldState.status = null;
 this._yieldState.resultFile = null;
 this._yieldState.processedCount = 0;

 if (this._yieldState.pollInterval) {
 clearInterval(this._yieldState.pollInterval);
 this._yieldState.pollInterval = null;
 }

 await this._loadYieldUsage();
 this._renderYieldUpload();
 },

 // ============ BOND SCANNER ============

 _scannerState: {
 jobId: null,
 status: null,
 pollInterval: null,
 usage: null,
 maxPrice: 100,
 minYield: 3,
 maxMaturity: 9,
 minRating: 'BBB',          // Task 15 (2026-05-28) — default BBB (was BBB-)
 targetCount: 50,            // Range 1-50 (2026-05-28 — best-N triés par rating desc)
 currencies: { EUR: true, USD: true, GBP: true },
 priceThreshold: 101,
 ratingKey: null,            // Task 16 — set by _scannerLoadKeyStatus()
 },

 async openBondScanner() {
 if (this._refreshInterval) {
 clearInterval(this._refreshInterval);
 this._refreshInterval = null;
 }

 // Check for active job
 try {
 const r = await Auth.apiCall('/api/bots/scanner/active');
 if (r && r.ok) {
 const data = await r.json();
 if (data.found) {
 this._scannerState.jobId = data.job_id;
 this._scannerState.status = data.status;
 if (data.status === 'running') {
 this._renderScannerRunning();
 Toast.success(Lang.t('yield.reconnected'));
 return;
 } else if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
 this._renderScannerCompleted(data);
 return;
 }
 }
 }
 } catch (e) { console.warn('[Scanner] No active job:', e); }

 this._scannerState.jobId = null;
 this._scannerState.status = null;
 await this._loadScannerUsage();
 this._renderScannerConfig();
 },

 async openMCAgent() {
 if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
 if (this._mcAgentTimer) { clearInterval(this._mcAgentTimer); this._mcAgentTimer = null; }
 this._mcaMapStop();
 this._mcaWorkersStop();
 this._mcaMapViewerOpen = false;
 this._mcAgentSession = this._mcAgentSession || null;
 const el = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!el) return;
 const __mcaU = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
 this._mcaRecTester = !!(__mcaU && !__mcaU.is_admin && __mcaU.role === 'rectester');
 if (this._mcaRecTester) return this._renderMCAgentRecTester(el);
 // Navigation 2 niveaux :
 //  niveau 1 : _mcaView ∈ {create,list} (défaut 'list')
 //  niveau 2 : _mcaGroupId non-null → vue groupe, sous-onglets _mcaGroupTab ∈ {workers,map}
 //             (édition des réglages via l'engrenage ⚙ de l'en-tête, plus par onglet)
 this._mcaView = (this._mcaView === 'create') ? 'create' : 'list';
 this._mcaGroupId = this._mcaGroupId || null;
 this._mcaGroupTab = this._mcaGroupTab || 'workers';
 el.innerHTML = `<div class="card"><h3 style="margin:0 0 12px;">MC Agent — ${Lang.t('mcagent.training')}</h3><div id="mca-root"></div></div>`;
 this._renderMCARoot();
 },

    openHarvester() {
        const u = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
        if (!u || !u.is_admin) return;
        if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
        if (typeof HarvesterModule !== 'undefined') {
            HarvesterModule.render(this._container);
        }
    },

    openOracle() {
        const u = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
        if (!u || !u.is_admin) return;
        if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
        if (typeof OracleModule !== 'undefined') {
            OracleModule.render(this._container);
        }
    },

 _renderMCARoot() {
 const root = document.getElementById('mca-root');
 if (!root) return;
 if (this._mcaGroupId) { this._renderMCAGroup(); return; }
 const v = this._mcaView || 'list';
 const tabBtn = (id, label) => `<button class="btn btn-ghost btn-sm" style="border-radius:0;border-bottom:2px solid ${v === id ? 'var(--accent)' : 'transparent'};" onclick="BotsModule.switchMCAView('${id}')">${label}</button>`;
 root.innerHTML = `
 <div style="display:flex;gap:6px;margin:0 0 14px;border-bottom:1px solid var(--border);">
 ${tabBtn('create', Lang.t('mcagent.nav.create'))}
 ${tabBtn('list', Lang.t('mcagent.nav.list'))}
 ${tabBtn('mod', Lang.t('mcagent.nav.mod'))}
 </div>
 <div id="mca-tabbody"></div>`;
 if (v === 'create') this._renderGroupCreate();
 else if (v === 'mod') this._renderMCAMod();
 else this._renderGroupList();
 },

 switchMCAView(view) {
 this._mcaMapStop(); // coupe l'auto-refresh + le listener resize de la carte quand on quitte la vue
 this._mcaWorkersStop();
 this._mcaGroupId = null;
 this._mcaEditing = null;
 this._mcaSettingsOpen = false;
 this._mcaMapViewerOpen = false;
 this._mcaView = view;
 this._renderMCARoot();
 },

 // ----- Navigation niveau 2 (vue groupe) -----
 openGroup(id) {
 this._mcaMapStop();
 this._mcaWorkersStop();
 this._mcaWorkerForm = false;
 this._mcaSettingsOpen = false;
 this._mcaMapViewerOpen = false;
 this._mcaGroupId = id;
 this._mcaGroupTab = 'workers';
 this._renderMCARoot();
 },

 backToList() {
 this._mcaMapStop();
 this._mcaWorkersStop();
 this._mcaGroupId = null;
 this._mcaEditing = null;
 this._mcaSettingsOpen = false;
 this._mcaMapViewerOpen = false;
 this._mcaView = 'list';
 this._renderMCARoot();
 },

 switchMCAGroupTab(tab) {
 this._mcaMapStop();
 this._mcaWorkersStop();
 this._mcaWorkerForm = false;
 this._mcaSettingsOpen = false;
 this._mcaMapViewerOpen = false;
 this._mcaGroupTab = tab;
 this._renderMCARoot();
 },

 _mcaGroup() {
 return (this._mcaServers || []).find((x) => x.id === this._mcaGroupId) || null;
 },

 async _renderMCAGroup() {
 const root = document.getElementById('mca-root');
 if (!root) return;
 // recharge la liste des groupes si on n'a pas le courant en mémoire (ex. reload direct)
 let g = this._mcaGroup();
 if (!g) {
  await this._ensureCatalog();
  try {
   const r = await Auth.apiCall('/api/mc-agent/servers');
   const data = await r.json();
   this._mcaServers = data.servers || [];
  } catch (e) { this._mcaServers = this._mcaServers || []; }
  g = this._mcaGroup();
 }
 if (!g) { this.backToList(); return; }
 // Réglages du groupe : ouverts via l'engrenage ⚙ de l'en-tête (panneau dépliable, plus d'onglet « Modifier »).
 const settingsOpen = !!this._mcaSettingsOpen;
 const tab = (this._mcaGroupTab === 'map') ? 'map' : 'workers';
 const tabBtn = (id, label) => `<button class="btn btn-ghost btn-sm" style="border-radius:0;border-bottom:2px solid ${tab === id ? 'var(--accent)' : 'transparent'};" onclick="BotsModule.switchMCAGroupTab('${id}')">${label}</button>`;
 root.innerHTML = `
 <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
 <button class="btn btn-ghost btn-sm" onclick="BotsModule.backToList()">${Lang.t('mcagent.nav.back')}</button>
 <div>
 <div style="font-weight:600;">${this._escapeHtml(g.name)}</div>
 <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">${this._escapeHtml(g.host || '?')}:${g.port}</div>
 </div>
 <button class="btn ${settingsOpen ? 'btn-secondary' : 'btn-ghost'} btn-sm" style="margin-left:auto;" aria-expanded="${settingsOpen}" title="${Lang.t('mcagent.group.settings')}" onclick="BotsModule.toggleGroupSettings()">⚙ ${Lang.t('mcagent.group.settings')}</button>
 </div>
 ${settingsOpen ? '' : `<div style="display:flex;gap:6px;margin:0 0 14px;border-bottom:1px solid var(--border);">
 ${tabBtn('workers', Lang.t('mcagent.nav.workers'))}
 ${tabBtn('map', Lang.t('mcagent.nav.map'))}
 </div>`}
 <div id="mca-tabbody"></div>`;
 const body = document.getElementById('mca-tabbody');
 if (settingsOpen) {
  // Panneau réglages (engrenage) : réutilise l'éditeur (pré-rempli).
  this._mcaEditing = JSON.parse(JSON.stringify(g));
  if (!Array.isArray(this._mcaEditing.custom)) this._mcaEditing.custom = [];
  if (!Array.isArray(this._mcaEditing.trusted)) this._mcaEditing.trusted = [];
  if (!this._mcaEditing.trade || typeof this._mcaEditing.trade !== 'object') this._mcaEditing.trade = { acceptCmd: '', requestPattern: '' };
  body.innerHTML = `<div id="mca-srv-editor"></div>`;
  this._renderServerEditor();
 } else if (tab === 'map') {
  this._renderGroupMap(g);
 } else {
  this._renderGroupWorkers();
 }
 },

 // Ouvre/ferme le panneau réglages du groupe (engrenage ⚙). Coupe les timers carte/workers à l'ouverture.
 toggleGroupSettings() {
 this._mcaSettingsOpen = !this._mcaSettingsOpen;
 if (this._mcaSettingsOpen) { this._mcaMapStop(); this._mcaWorkersStop(); this._mcaMapViewerOpen = false; }
 else { this._mcaEditing = null; }
 this._renderMCARoot();
 },

 // ============ Task 10 — Onglet « Bots ouvriers » ============
 // Roster des bots role==='worker' du groupe : création (form inline), lancement
 // (companion = LLM sans autonomous | objectifs autonomes), stop, suppression.
 // Statut en ligne matché sur GET /api/mc-agent/active (s.user === bot.username, casse-insensible).

 _mcaWorkersStop() {
 if (this._mcaWorkersTimer) { clearInterval(this._mcaWorkersTimer); this._mcaWorkersTimer = null; }
 },

 async _renderGroupWorkers() {
 const body = document.getElementById('mca-tabbody');
 if (!body) return;
 this._mcaWorkersStop();
 body.innerHTML = `<div id="mca-w-root" style="padding-top:6px;"><div style="font-size:12px;color:var(--text-dim);">…</div></div>`;
 await this._reloadGroupWorkers();
 // Auto-refresh léger du statut en ligne tant que l'onglet workers est affiché.
 this._mcaWorkersTimer = setInterval(() => {
  if (this._mcaGroupId && this._mcaGroupTab === 'workers' && document.getElementById('mca-w-root')) BotsModule._refreshWorkersStatus();
  else BotsModule._mcaWorkersStop();
 }, 5000);
 },

 // Recharge le groupe + sessions actives et re-render complet du roster.
 async _reloadGroupWorkers() {
 try {
  const r = await Auth.apiCall('/api/mc-agent/servers');
  const data = await r.json();
  this._mcaServers = data.servers || [];
 } catch (e) { this._mcaServers = this._mcaServers || []; }
 await this._loadActiveByServer();
 this._renderWorkersBody();
 },

 // Recharge uniquement les sessions actives puis re-render (auto-refresh 5s).
 async _refreshWorkersStatus() {
 await this._loadActiveByServer();
 this._renderWorkersBody();
 },

 // Sessions actives du groupe courant (liste).
 _groupSessions() {
 return (this._mcaActiveByServer || {})[this._mcaGroupId] || [];
 },

 // Session en ligne d'un bot, matchée par username (insensible casse).
 _botSession(username) {
 const u = (username || '').toLowerCase();
 return this._groupSessions().find((s) => (s.user || '').toLowerCase() === u) || null;
 },

 // Couleur par TYPE de minerai (5 types quota — fixes, indépendantes de l'accent).
 _oreBase(mat) {
 let m = String(mat || '');
 if (m.startsWith('deepslate_')) m = m.slice(10);
 if (m.endsWith('_ore')) m = m.slice(0, -4);
 return m;
 },
 _oreColor(mat) {
 const c = { diamond: '#4DD0E1', gold: '#FACC15', redstone: '#F87171', lapis: '#60A5FA', iron: '#D9C9A3' };
 return c[this._oreBase(mat)] || '#A1A1AA';
 },

 // Couleur + initiale par TYPE de structure (fixes, lisibles sur fond biome).
 _structColor(kind) {
 const c = { village: '#4ADE80', mineshaft: '#D9C9A3', stronghold: '#C084FC', dungeon: '#F87171',
  ancient_city: '#60A5FA', ruined_portal: '#FB923C', desert_pyramid: '#FACC15', jungle_pyramid: '#34D399',
  pillager_outpost: '#F472B6', shipwreck: '#94A3B8', monument: '#22D3EE', fortress: '#EF4444' };
 return c[kind] || '#A1A1AA';
 },
 _structInitial(kind) {
 const i = { village: 'V', mineshaft: 'M', stronghold: 'S', dungeon: 'D', ancient_city: 'A',
  ruined_portal: 'P', desert_pyramid: 'T', jungle_pyramid: 'T', pillager_outpost: 'O',
  shipwreck: 'W', monument: 'Mo', fortress: 'F' };
 return i[kind] || '?';
 },

 // Nom i18n d'un type de structure ; kind inconnu → kind lisible (piège #12 : Lang.t rend la clé).
 _mcaStructName(kind) {
 const t = Lang.t('mcagent.map.struct.' + kind);
 return (t || '').startsWith('mcagent.') ? String(kind).replace(/_/g, ' ') : t;
 },

 // Barres de progression quota d'une session (sess.quota = {type:{have,target}}, cf. backend).
 _quotaBars(sess) {
 const q = sess.quota || {};
 const types = ['diamond', 'gold', 'redstone', 'lapis', 'iron'].filter((t) => q[t]);
 if (!types.length) return '';
 const doneBadge = sess.quota_done
  ? `<span class="badge online" style="margin-left:8px;">${Lang.t('mcagent.quota.done')}</span>` : '';
 const bars = types.map((t) => {
  const have = Math.max(0, Number(q[t].have) || 0);
  const target = Math.max(1, Number(q[t].target) || 1);
  const pct = Math.min(100, Math.round((have / target) * 100));
  return `
  <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
   <span style="width:64px;font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${this._escapeHtml(t)}</span>
   <div style="flex:1;height:6px;background:var(--bg-elev-3);border-radius:999px;overflow:hidden;">
    <div style="width:${pct}%;height:100%;background:${this._oreColor(t)};border-radius:999px;"></div>
   </div>
   <span style="width:62px;text-align:right;font-size:11px;font-family:var(--font-mono);color:${have >= target ? 'var(--accent)' : 'var(--text-muted)'};">${have}/${target}</span>
  </div>`;
 }).join('');
 return `
 <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
  <div style="font-size:11px;text-transform:uppercase;color:var(--text-dim);">${Lang.t('mcagent.quota.title')}${doneBadge}</div>
  ${bars}
 </div>`;
 },

 _renderWorkersBody() {
 const root = document.getElementById('mca-w-root');
 const g = this._mcaGroup();
 if (!root || !g) return;
 const workers = (g.bots || []).filter((b) => b.role === 'worker');
 const showForm = !!this._mcaWorkerForm;
 const rows = workers.map((b) => {
  const sess = this._botSession(b.username);
  const online = !!sess;
  const authBadge = `<span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);">${this._escapeHtml(b.auth || 'offline')}</span>`;
  const secretBadge = b.has_secret ? `<span class="badge" title="${Lang.t('mcagent.bot.secret_saved')}" style="margin-left:4px;">${Lang.t('mcagent.bot.secret_ok')}</span>` : '';
  const onlineBadge = online
   ? `<span class="badge online" style="margin-left:6px;">${Lang.t('mcagent.bot.online')} · #${this._escapeHtml(String(sess.id))}</span>`
   : `<span class="badge" style="margin-left:6px;">${Lang.t('mcagent.bot.offline')}</span>`;
  const actionBtn = online
   ? `<button class="btn btn-secondary btn-sm" onclick="BotsModule.stopWorkerBot('${this._escapeHtml(String(sess.id))}')">${Lang.t('mcagent.bot.stop')}</button>`
   : `<button class="btn btn-primary btn-sm" onclick="BotsModule.startWorkerBot('${this._escapeHtml(b.id)}')">${Lang.t('mcagent.bot.launch')}</button>`;
  const quotaBlock = (online && sess.quota) ? this._quotaBars(sess) : '';
  return `
  <div style="padding:10px 12px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
   <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
    <div>
     <div style="font-weight:600;font-family:var(--font-mono);">${this._escapeHtml(b.username)}${onlineBadge}</div>
     <div style="margin-top:2px;">${authBadge}${secretBadge}</div>
    </div>
    <div style="display:flex;gap:6px;">
     ${actionBtn}
     <button class="btn btn-ghost btn-sm" onclick="BotsModule.deleteWorkerBot('${this._escapeHtml(b.id)}')">${Lang.t('mcagent.bot.delete')}</button>
    </div>
   </div>
   ${quotaBlock}
  </div>
  <div id="mca-w-msa-${this._escapeHtml(b.id)}"></div>`;
 }).join('');
 root.innerHTML = `
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
  <label class="form-label" style="margin:0;">${Lang.t('mcagent.bot.mode')}</label>
  <select id="mca-w-objective" class="form-input" style="max-width:240px;">
   <option value="companion">${Lang.t('mcagent.bot.mode_companion')}</option>
   <option value="stone_pickaxe">${Lang.t('mcagent.obj_stone')}</option>
   <option value="iron_pickaxe">${Lang.t('mcagent.obj_iron')}</option>
   <option value="diamond">${Lang.t('mcagent.obj_diamond')}</option>
   <option value="resource">${Lang.t('mcagent.obj_resource')}</option>
  </select>
 </div>
 ${workers.length ? rows : `<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">${Lang.t('mcagent.bot.empty')}</div>`}
 <div style="margin-top:8px;">
  ${showForm ? this._renderWorkerForm(g) : `<button class="btn btn-secondary btn-sm" onclick="BotsModule.toggleWorkerForm(true)">${Lang.t('mcagent.bot.add')}</button>`}
 </div>`;
 if (showForm) this._wireWorkerForm(g);
 },

 _renderWorkerForm(g) {
 return `
 <div style="background:var(--bg-elev-3);border:1px solid var(--border);border-radius:10px;padding:14px;">
  <div style="font-weight:600;font-size:13px;margin-bottom:10px;">${Lang.t('mcagent.bot.add_title')}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
   <div><label class="form-label">${Lang.t('mcagent.bot.username')}</label><input id="mca-w-user" class="form-input" placeholder="${Lang.t('mcagent.bot.username_ph')}" /></div>
   <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label>
    <select id="mca-w-auth" class="form-input" onchange="BotsModule._toggleWorkerSecret()">
     <option value="offline">${Lang.t('mcagent.auth_offline')}</option>
     <option value="microsoft">${Lang.t('mcagent.auth_microsoft')}</option>
    </select></div>
  </div>
  <div id="mca-w-secret-wrap" style="display:${g.has_login ? 'block' : 'none'};margin-top:10px;">
   <label class="form-label">${Lang.t('mcagent.bot.secret')}</label>
   <input id="mca-w-secret" class="form-input" type="password" autocomplete="new-password" placeholder="${Lang.t('mcagent.bot.secret_ph')}" style="max-width:280px;" />
   <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${Lang.t('mcagent.bot.secret_hint')}</div>
  </div>
  <div style="display:flex;gap:8px;margin-top:14px;">
   <button class="btn btn-primary btn-sm" onclick="BotsModule.createWorkerBot()">${Lang.t('mcagent.bot.create')}</button>
   <button class="btn btn-ghost btn-sm" onclick="BotsModule.toggleWorkerForm(false)">${Lang.t('mcagent.cfg.srv_cancel')}</button>
  </div>
 </div>`;
 },

 // Le champ secret n'est utile que pour les comptes offline sur un serveur à login.
 _wireWorkerForm(g) { this._toggleWorkerSecret(); },

 _toggleWorkerSecret() {
 const g = this._mcaGroup();
 const wrap = document.getElementById('mca-w-secret-wrap');
 const authEl = document.getElementById('mca-w-auth');
 if (!wrap || !authEl || !g) return;
 const show = !!g.has_login && authEl.value === 'offline';
 wrap.style.display = show ? 'block' : 'none';
 },

 toggleWorkerForm(on) {
 this._mcaWorkerForm = !!on;
 this._renderWorkersBody();
 },

 async createWorkerBot() {
 const g = this._mcaGroup();
 if (!g) return;
 const username = (document.getElementById('mca-w-user') || {}).value;
 const auth = (document.getElementById('mca-w-auth') || {}).value || 'offline';
 const u = (username || '').trim();
 if (!u) { Toast.error(Lang.t('mcagent.bot.username_required')); return; }
 const secretEl = document.getElementById('mca-w-secret');
 const payload = { role: 'worker', username: u, auth };
 if (g.has_login && auth === 'offline' && secretEl && secretEl.value) payload.secret = secretEl.value;
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(g.id)}/bots`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
 });
 const data = await (r ? r.json().catch(() => ({})) : Promise.resolve({}));
 if (!r || !r.ok) { Toast.error((data && data.detail) || Lang.t('mcagent.bot.create_err')); return; }
 this._mcaWorkerForm = false;
 await this._reloadGroupWorkers();
 },

 async deleteWorkerBot(botId) {
 const g = this._mcaGroup();
 if (!g) return;
 // nom récupéré par lookup (jamais de username dans un onclick : breakout de chaîne possible)
 const name = ((g.bots || []).find((b) => b.id === botId) || {}).username || '';
 if (!confirm(Lang.t('mcagent.bot.confirm_delete').replace('{name}', name))) return;
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(g.id)}/bots/${encodeURIComponent(botId)}`, { method: 'DELETE' });
 if (!r || !r.ok) { Toast.error(Lang.t('mcagent.bot.delete_err')); return; }
 await this._reloadGroupWorkers();
 },

 async startWorkerBot(botId) {
 const g = this._mcaGroup();
 if (!g) return;
 const mode = (document.getElementById('mca-w-objective') || {}).value || 'companion';
 const bot = (g.bots || []).find((b) => b.id === botId) || {};
 const body = { server_id: g.id, bot_id: botId };
 // companion = compagnon LLM (pas d'autonomie) ; sinon objectif planner autonome.
 if (mode !== 'companion') { body.autonomous = true; body.objective = mode; }
 // Bot ressource : quota mission par défaut (15💎/15 or/64 redstone/64 lapis/64 fer)
 if (mode === 'resource') body.quota = { diamond: 15, gold: 15, redstone: 64, lapis: 64, iron: 64 };
 const r = await Auth.apiCall('/api/mc-agent/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
 });
 const data = await (r ? r.json().catch(() => ({})) : Promise.resolve({}));
 if (!r || !r.ok) { Toast.error((data && data.detail) || Lang.t('mcagent.bot.launch_err')); return; }
 await this._reloadGroupWorkers();
 // Microsoft device-code : on cherche l'event msa dans le transcript de la session fraîche.
 if (bot.auth === 'microsoft' && data.session_id) this._pollWorkerMsa(botId, data.session_id);
 },

 async stopWorkerBot(sessionId) {
 const r = await Auth.apiCall(`/api/mc-agent/stop/${encodeURIComponent(sessionId)}`, { method: 'POST' });
 if (!r || !r.ok) { Toast.error(Lang.t('mcagent.bot.stop_err')); return; }
 await this._reloadGroupWorkers();
 },

 // Cherche l'event device-login Microsoft (type:'msa') dans les 1ères secondes ; rien trouvé = compte déjà lié.
 async _pollWorkerMsa(botId, sessionId, attempt) {
 attempt = attempt || 0;
 if (attempt >= 4) return;
 if (!(this._mcaGroupId === (this._mcaGroup() || {}).id && this._mcaGroupTab === 'workers')) return;
 try {
  const r = await Auth.apiCall(`/api/mc-agent/chat/${encodeURIComponent(sessionId)}`);
  const data = await r.json().catch(() => ({}));
  const msa = ((data && data.transcript) || []).find((e) => e.type === 'msa');
  if (msa) {
   const box = document.getElementById('mca-w-msa-' + botId);
   if (box) box.innerHTML = `
   <div style="background:var(--bg-elev-3);border:1px solid var(--accent);border-radius:8px;padding:10px 12px;margin:-2px 0 8px;">
    <div style="font-weight:600;font-size:12px;margin-bottom:4px;">${Lang.t('mcagent.bot.msa_title')}</div>
    <div style="font-size:12px;color:var(--text-muted);white-space:pre-wrap;font-family:var(--font-mono);">${this._escapeHtml(msa.message || '')}</div>
   </div>`;
   return;
  }
 } catch (e) { /* silencieux */ }
 setTimeout(() => BotsModule._pollWorkerMsa(botId, sessionId, attempt + 1), 3000);
 },

 _renderMCALaunch() {
 const body = document.getElementById('mca-tabbody');
 if (!body) return;
 body.innerHTML = `
 ${BotsModule._mcaModBlock()}
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);">
 <span style="font-size:13px;font-weight:600;">${Lang.t('mcagent.key_title')}</span>
 <span id="mca-key-status" style="font-size:12px;color:var(--text-muted);">…</span>
 <input id="mca-key" class="form-input" type="password" placeholder="${Lang.t('mcagent.key_placeholder')}" style="flex:1;min-width:160px;" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.saveMCAgentKey()">${Lang.t('mcagent.key_save')}</button>
 <button class="btn btn-ghost btn-sm" onclick="BotsModule.clearMCAgentKey()">${Lang.t('mcagent.key_clear')}</button>
 </div>
 <div style="margin-bottom:10px;">
 <label class="form-label">${Lang.t('mcagent.cfg.profile_select')}</label>
 <select id="mca-server-profile" class="form-input" onchange="BotsModule.applyServerProfile()">
 <option value="">${Lang.t('mcagent.cfg.profile_manual')}</option>
 </select>
 </div>
 <div style="display:grid;grid-template-columns:1fr 100px;gap:10px;margin-bottom:10px;">
 <div><label class="form-label">${Lang.t('mcagent.ip')}</label><input id="mca-host" class="form-input" placeholder="192.168.1.x ou play.exemple.net" /></div>
 <div><label class="form-label">${Lang.t('mcagent.port')}</label><input id="mca-port" class="form-input" placeholder="25565" /></div>
 </div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
 <div><label class="form-label">${Lang.t('mcagent.account')}</label><input id="mca-user" class="form-input" value="TrainBot" placeholder="pseudo ou email" /></div>
 <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label><select id="mca-auth" class="form-input"><option value="offline">${Lang.t('mcagent.auth_offline')}</option><option value="microsoft">${Lang.t('mcagent.auth_microsoft')}</option></select></div>
 <div><label class="form-label">${Lang.t('mcagent.profile')}</label><select id="mca-profile" class="form-input" onchange="BotsModule.renderMCAgentTells()"></select></div>
 </div>
 <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px;">${Lang.t('mcagent.ms_hint')}</div>
 <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text-muted);cursor:pointer;margin-bottom:8px;">
 <input type="checkbox" id="mca-autonomous" /> ${Lang.t('mcagent.autonomous')}
 </label>
 <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
 <select id="mca-objective" class="form-input" style="max-width:260px;">
 <option value="stone_pickaxe">${Lang.t('mcagent.obj_stone')}</option>
 <option value="iron_pickaxe">${Lang.t('mcagent.obj_iron')}</option>
 <option value="diamond">${Lang.t('mcagent.obj_diamond')}</option>
 <option value="mapper">${Lang.t('mcagent.obj_mapper')}</option>
 </select>
 <input id="mca-world-label" class="form-input" style="max-width:200px;" placeholder="${Lang.t('mcagent.world_label')}" />
 </div>
 <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
 <button class="btn btn-primary" onclick="BotsModule.startMCAgent()">${Lang.t('mcagent.start')}</button>
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.stopMCAgent()">${Lang.t('mcagent.stop')}</button>
 <span id="mca-msg" style="font-size:13px;color:var(--text-muted);"></span>
 </div>
 <div id="mca-tells" style="display:none;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--text-muted);"></div>
 <details class="card" style="margin-top:12px;">
 <summary style="cursor:pointer;font-weight:600;">${Lang.t('mcagent.commands_title')}</summary>
 <div style="font-family:var(--font-mono);font-size:12px;line-height:1.7;margin-top:8px;white-space:pre-wrap;">${Lang.t('mcagent.commands_help')}</div>
 </details>
 <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;">
 <div style="font-weight:600;margin-bottom:4px;">${Lang.t('mcagent.capture_title')}</div>
 <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.capture_hint')}</div>
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
 <input id="mca-capfile" type="file" accept=".jsonl,.gz" class="form-input" style="flex:1;min-width:200px;" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.uploadCapture()">${Lang.t('mcagent.capture_import')}</button>
 </div>
 <div id="mca-captures"></div>
 </div>
 <div id="mca-transcript" style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;"></div>
 <div style="display:flex;gap:8px;margin-top:10px;">
 <input id="mca-say" class="form-input" placeholder="${Lang.t('mcagent.say_placeholder')}" style="flex:1;" />
 <button class="btn btn-secondary" onclick="BotsModule.sayMCAgent()">${Lang.t('mcagent.send')}</button>
 </div>`;
 this._loadMCAgentKey();
 this.loadMCAgentProfiles();
 this.loadModVersions();
 this.loadCaptures();
 this.loadLaunchServerProfiles();
 },

 _mcaModBlock() {
 return `
 <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
 <div style="font-weight:600;margin-bottom:6px;">${Lang.t('mcagent.mod_download')}</div>
 <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.mod_pick')}</div>
 <div id="mca-mod-versions" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
 <details open style="margin-top:10px;">
 <summary style="cursor:pointer;font-size:13px;">${Lang.t('mcagent.tuto_title')}</summary>
 <ol style="font-size:12px;color:var(--text-muted);line-height:1.7;margin:8px 0 0;padding-left:18px;">
 <li>${Lang.t('mcagent.tuto_s1')} <a href="https://fabricmc.net/use/installer/" target="_blank" rel="noopener">fabricmc.net/use/installer</a></li>
 <li>${Lang.t('mcagent.tuto_s2')} <a href="https://modrinth.com/mod/fabric-api" target="_blank" rel="noopener">modrinth.com/mod/fabric-api</a></li>
 <li>${Lang.t('mcagent.tuto_s3')}</li>
 <li>${Lang.t('mcagent.tuto_s4')}</li>
 <li>${Lang.t('mcagent.tuto_s5')}</li>
 </ol>
 </details>
 </div>`;
 },

 // Onglet « Mods & REC » (niveau 1) : télécharger le mod client + tuto d'install + déposer les captures (REC).
 _renderMCAMod() {
 const body = document.getElementById('mca-tabbody');
 if (!body) return;
 body.innerHTML = `
 <div style="font-size:12px;color:var(--text-muted);margin:0 0 12px;">${Lang.t('mcagent.mod_tab_intro')}</div>
 ${BotsModule._mcaModBlock()}
 <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;">
 <div style="font-weight:600;margin-bottom:4px;">${Lang.t('mcagent.my_captures')}</div>
 <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.capture_hint')}</div>
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
 <input id="mca-capfile" type="file" accept=".jsonl,.gz" class="form-input" style="flex:1;min-width:200px;" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.uploadCapture()">${Lang.t('mcagent.capture_import')}</button>
 </div>
 <div id="mca-captures"></div>
 </div>`;
 this.loadModVersions();
 this.loadCaptures();
 },

 _renderMCAgentRecTester(el) {
 el.innerHTML = `
 <div class="card">
 <h3 style="margin:0 0 12px;">MC Agent — ${Lang.t('mcagent.training')}</h3>
 ${this._mcaModBlock()}
 <div style="border-top:1px solid var(--border);margin:14px 0;padding-top:12px;">
 <div style="font-weight:600;margin-bottom:4px;">${Lang.t('mcagent.my_captures')}</div>
 <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('mcagent.capture_hint')}</div>
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
 <input id="mca-capfile" type="file" accept=".jsonl,.gz" class="form-input" style="flex:1;min-width:200px;" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.uploadCapture()">${Lang.t('mcagent.capture_import')}</button>
 </div>
 <div id="mca-captures"></div>
 </div>
 </div>`;
 this.loadModVersions();
 this.loadCaptures();
 },

 async loadModVersions() {
 const box = document.getElementById('mca-mod-versions');
 if (!box) return;
 try {
 const r = await Auth.apiCall('/api/mc-agent/mod');
 const data = await r.json();
 const vers = (data && data.versions) || [];
 box.innerHTML = vers.length
 ? vers.map((v) => `<button class="btn btn-secondary btn-sm" onclick="BotsModule.downloadMod('${this._escapeHtml(v.version)}')">MC ${this._escapeHtml(v.version)}</button>`).join('')
 : `<span style="font-size:12px;color:var(--text-dim);">—</span>`;
 } catch (e) { /* silencieux */ }
 },

 async downloadMod(version) {
 const r = await Auth.apiCall('/api/mc-agent/mod/' + encodeURIComponent(version));
 if (!r || !r.ok) { Toast.error(Lang.t('mcagent.mod_download')); return; }
 const blob = await r.blob();
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url; a.download = `mc-capture-${version}.jar`;
 document.body.appendChild(a); a.click(); a.remove();
 URL.revokeObjectURL(url);
 },

 async deleteSession(player, file) {
 const r = await Auth.apiCall(`/api/mc-agent/captures/${encodeURIComponent(player)}/${encodeURIComponent(file)}`, { method: 'DELETE' });
 if (r && r.ok) this.loadCaptures();
 else Toast.error(Lang.t('mcagent.capture_delete'));
 },

 async startMCAgent() {
 const serverId = (document.getElementById('mca-server-profile') || {}).value || '';
 const msg = document.getElementById('mca-msg');
 // Mode autonome : le bot lance la boucle planner (zéro→pioche pierre/fer) dès le spawn, 0 LLM.
 const autonomous = !!(document.getElementById('mca-autonomous') || {}).checked;
 const objective = (document.getElementById('mca-objective') || {}).value || 'stone_pickaxe';
 // Clé de monde explicite (monde de minage) — vide = dimension auto côté bot
 const worldLabel = ((document.getElementById('mca-world-label') || {}).value || '').trim() || undefined;
 let bodyData;
 if (serverId) {
 bodyData = { server_id: serverId, autonomous, objective, world_label: worldLabel };
 } else {
 const host = document.getElementById('mca-host').value.trim();
 if (!host) { msg.textContent = Lang.t('mcagent.need_host'); return; }
 const port = parseInt(document.getElementById('mca-port').value, 10) || 25565;
 const user = document.getElementById('mca-user').value.trim() || 'TrainBot';
 const auth = document.getElementById('mca-auth').value;
 const profile = (document.getElementById('mca-profile') || {}).value || undefined;
 bodyData = { host, port, user, auth, profile, autonomous, objective, world_label: worldLabel };
 }
 const r = await Auth.apiCall('/api/mc-agent/run', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(bodyData),
 });
 if (!r) return;
 const data = await r.json().catch(() => ({}));
 if (!r.ok) { msg.textContent = data.detail || 'Erreur'; return; }
 this._mcAgentSession = data.session_id;
 msg.textContent = `session #${data.session_id}`;
 this._mcAgentTimer = setInterval(() => BotsModule.refreshMCAgent(), 3000);
 },

 async loadLaunchServerProfiles() {
 const sel = document.getElementById('mca-server-profile');
 if (!sel) return;
 try {
 const r = await Auth.apiCall('/api/mc-agent/servers');
 const data = await r.json();
 this._mcaServers = data.servers || [];
 sel.innerHTML = `<option value="">${Lang.t('mcagent.cfg.profile_manual')}</option>`
 + this._mcaServers.map((s) => `<option value="${this._escapeHtml(s.id)}">${this._escapeHtml(s.name)} (${this._escapeHtml(s.host || '?')})</option>`).join('');
 } catch (e) { /* silencieux */ }
 },

 applyServerProfile() {
 const sel = document.getElementById('mca-server-profile');
 if (!sel || !sel.value) return;
 const s = (this._mcaServers || []).find((x) => x.id === sel.value);
 if (!s) return;
 const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
 set('mca-host', s.host); set('mca-port', s.port); set('mca-user', s.user);
 set('mca-auth', s.auth); set('mca-profile', s.intelligence);
 },

 async _ensureCatalog() {
 if (this._mcaCatalog) return;
 try {
 const r = await Auth.apiCall('/api/mc-agent/commands-catalog');
 const data = await r.json();
 this._mcaCatalog = data.catalog || [];
 } catch (e) { this._mcaCatalog = []; }
 },

 // ----- Niveau 1 : Créer un groupe (réutilise l'éditeur serveur) -----
 _renderGroupCreate() {
 const body = document.getElementById('mca-tabbody');
 if (!body) return;
 this._mcaEditing = { id: null, name: '', host: '', port: 25565, user: 'TrainBot', auth: 'offline', intelligence: 'intermediaire', language: 'fr', commands: [], custom: [], trusted: [], trade: { acceptCmd: '', requestPattern: '' }, has_login: false, login_command: '/login {pwd}' };
 body.innerHTML = `<div id="mca-srv-editor"></div>`;
 this._ensureCatalog().then(() => this._renderServerEditor());
 },

 // ----- Niveau 1 : Mes serveurs (cartes de groupes) -----
 _renderGroupList() {
 const body = document.getElementById('mca-tabbody');
 if (!body) return;
 body.innerHTML = `<div id="mca-srv-list" style="font-size:12px;color:var(--text-dim);padding:8px 0;">…</div>`;
 this.loadServerProfiles();
 },

 async loadServerProfiles() {
 await this._ensureCatalog();
 try {
 const r = await Auth.apiCall('/api/mc-agent/servers');
 const data = await r.json();
 this._mcaServers = data.servers || [];
 } catch (e) { this._mcaServers = []; }
 await this._loadActiveByServer();
 this._renderServerList();
 },

 // Mappe server_id -> LISTE de sessions en ligne (un groupe peut avoir plusieurs bots actifs).
 async _loadActiveByServer() {
 this._mcaActiveByServer = {};
 try {
 const r = await Auth.apiCall('/api/mc-agent/active');
 const data = await r.json();
 (data.sessions || []).forEach((s) => {
 if (s.server_id) (this._mcaActiveByServer[s.server_id] || (this._mcaActiveByServer[s.server_id] = [])).push(s);
 });
 } catch (e) { /* silencieux */ }
 },

 _renderServerList() {
 const list = document.getElementById('mca-srv-list');
 if (!list) return;
 const servers = this._mcaServers || [];
 if (!servers.length) { list.innerHTML = `<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">${Lang.t('mcagent.cfg.srv_empty')}</div>`; return; }
 const active = this._mcaActiveByServer || {};
 list.innerHTML = servers.map((s) => {
 const sessions = active[s.id] || [];
 const online = sessions.length > 0;
 const dot = online ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-right:6px;vertical-align:middle;" title="${Lang.t('mcagent.cfg.srv_online')}"></span>` : '';
 const onlineBadge = online ? `<span class="badge online" style="margin-left:6px;">${sessions.length} ${Lang.t('mcagent.nav.online')}</span>` : '';
 const nbBots = (s.bots || []).length;
 return `
 <div onclick="BotsModule.openGroup('${this._escapeHtml(s.id)}')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
 <div>
 <div style="font-weight:600;">${dot}${this._escapeHtml(s.name)}${onlineBadge}</div>
 <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">${this._escapeHtml(s.host || '?')}:${s.port} · ${nbBots} ${Lang.t('mcagent.nav.bots_count')}</div>
 </div>
 <div style="display:flex;gap:6px;" onclick="event.stopPropagation();">
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.openGroupEdit('${this._escapeHtml(s.id)}')">${Lang.t('mcagent.cfg.srv_edit')}</button>
 <button class="btn btn-ghost btn-sm" onclick="BotsModule.deleteServerProfile('${this._escapeHtml(s.id)}')">${Lang.t('mcagent.cfg.srv_delete')}</button>
 </div>
 </div>`;
 }).join('');
 },

 // Ouvre directement la vue groupe avec le panneau réglages (engrenage ⚙) déplié.
 openGroupEdit(id) {
 this._mcaMapStop();
 this._mcaWorkersStop();
 this._mcaWorkerForm = false;
 this._mcaMapViewerOpen = false;
 this._mcaGroupId = id;
 this._mcaGroupTab = 'workers';
 this._mcaSettingsOpen = true;
 this._renderMCARoot();
 },

 _renderServerEditor() {
 const box = document.getElementById('mca-srv-editor');
 const e = this._mcaEditing;
 if (!box || !e) return;
 const checked = new Set(e.commands || []);
 const cats = { communication: [], teleport: [], economy: [], status: [] };
 (this._mcaCatalog || []).forEach((c) => { (cats[c.category] || (cats[c.category] = [])).push(c); });
 const checklist = Object.keys(cats).filter((k) => cats[k].length).map((k) => `
 <div style="margin-bottom:8px;">
 <div style="font-size:11px;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px;">${this._escapeHtml(Lang.t('mcagent.cfg.cat_' + k))}</div>
 ${cats[k].map((c) => `
 <label style="display:inline-flex;align-items:center;gap:5px;margin:2px 10px 2px 0;font-size:12px;cursor:pointer;">
 <input type="checkbox" value="${this._escapeHtml(c.id)}" ${checked.has(c.id) ? 'checked' : ''} class="mca-cmd-cb" />
 <span style="font-family:var(--font-mono);">${this._escapeHtml(c.cmd)}</span>
 <span style="color:var(--text-dim);">${this._escapeHtml(c.syntax || '')}</span>
 </label>`).join('')}
 </div>`).join('');
 const customs = (e.custom || []).map((c, i) => `
 <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px;">
 <span style="font-family:var(--font-mono);">${this._escapeHtml(c.cmd)}</span>
 <span style="color:var(--text-dim);">${this._escapeHtml(c.syntax || '')}</span>
 <button class="btn btn-ghost btn-sm" onclick="BotsModule.removeCustomCommand(${i})">×</button>
 </div>`).join('');
 const trusted = (e.trusted || []).map((name, i) => `
 <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-elev-3);border:1px solid var(--border);border-radius:999px;padding:2px 8px;margin:2px 6px 2px 0;font-size:12px;">
 <span style="font-family:var(--font-mono);">${this._escapeHtml(name)}</span>
 <button class="btn btn-ghost btn-sm" style="padding:0 4px;" onclick="BotsModule.removeTrustedPlayer(${i})">×</button>
 </span>`).join('');
 const trade = e.trade || { acceptCmd: '', requestPattern: '' };
 box.innerHTML = `
 <div style="background:var(--bg-elev-2);border:1px solid var(--border);border-radius:10px;padding:14px;">
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
 <div><label class="form-label">${Lang.t('mcagent.cfg.srv_name')}</label><input id="mca-e-name" class="form-input" value="${this._escapeHtml(e.name)}" /></div>
 <div><label class="form-label">${Lang.t('mcagent.cfg.srv_intelligence')}</label>
 <select id="mca-e-intel" class="form-input">
 <option value="evident" ${e.intelligence === 'evident' ? 'selected' : ''}>${Lang.t('mcagent.profiles.evident')}</option>
 <option value="intermediaire" ${e.intelligence === 'intermediaire' ? 'selected' : ''}>${Lang.t('mcagent.profiles.intermediaire')}</option>
 <option value="expert" ${e.intelligence === 'expert' ? 'selected' : ''}>${Lang.t('mcagent.profiles.expert')}</option>
 </select></div>
 <div><label class="form-label">${Lang.t('mcagent.cfg.srv_language')}</label>
 <select id="mca-e-lang" class="form-input">
 <option value="fr" ${(e.language||'fr') === 'fr' ? 'selected' : ''}>Français</option>
 <option value="en" ${e.language === 'en' ? 'selected' : ''}>English</option>
 <option value="it" ${e.language === 'it' ? 'selected' : ''}>Italiano</option>
 </select></div>
 <div><label class="form-label">${Lang.t('mcagent.cfg.srv_stealth')}</label>
 <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);min-height:38px;">
 <input type="checkbox" id="mca-e-stealth" ${e.stealth ? 'checked' : ''} /> ${Lang.t('mcagent.cfg.srv_stealth_hint')}
 </label></div>
 <div><label class="form-label">${Lang.t('mcagent.ip')}</label><input id="mca-e-host" class="form-input" value="${this._escapeHtml(e.host)}" /></div>
 <div><label class="form-label">${Lang.t('mcagent.port')}</label><input id="mca-e-port" class="form-input" placeholder="25565" value="${e.port || ''}" /></div>
 ${this._mcaGroupId ? '' : `<div><label class="form-label">${Lang.t('mcagent.account')}</label><input id="mca-e-user" class="form-input" value="${this._escapeHtml(e.user)}" /></div>`}
 <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label>
 <select id="mca-e-auth" class="form-input">
 <option value="offline" ${e.auth === 'offline' ? 'selected' : ''}>${Lang.t('mcagent.auth_offline')}</option>
 <option value="microsoft" ${e.auth === 'microsoft' ? 'selected' : ''}>${Lang.t('mcagent.auth_microsoft')}</option>
 </select></div>
 </div>
 <div style="font-weight:600;font-size:13px;margin:10px 0 6px;">${Lang.t('mcagent.cfg.srv_commands')}</div>
 <div>${checklist || '<span style="font-size:12px;color:var(--text-dim);">—</span>'}</div>
 <div style="font-weight:600;font-size:13px;margin:12px 0 6px;">${Lang.t('mcagent.cfg.srv_custom')}</div>
 <div id="mca-e-customs">${customs}</div>
 <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
 <input id="mca-e-ccmd" class="form-input" placeholder="/kit" style="max-width:120px;" />
 <input id="mca-e-csyn" class="form-input" placeholder="/kit <nom>" style="max-width:160px;" />
 <input id="mca-e-cdesc" class="form-input" placeholder="${Lang.t('mcagent.cfg.custom_desc')}" style="flex:1;min-width:140px;" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.addCustomCommand()">${Lang.t('mcagent.cfg.srv_custom_add')}</button>
 </div>
 <div style="font-weight:600;font-size:13px;margin:14px 0 4px;">${Lang.t('mcagent.cfg.trusted_title')}</div>
 <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${Lang.t('mcagent.cfg.trusted_hint')}</div>
 <div id="mca-e-trusted">${trusted || `<span style="font-size:12px;color:var(--text-dim);">${Lang.t('mcagent.cfg.trusted_empty')}</span>`}</div>
 <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
 <input id="mca-e-trusted-add" class="form-input" placeholder="${Lang.t('mcagent.cfg.trusted_ph')}" style="flex:1;min-width:140px;" onkeydown="if(event.key==='Enter'){event.preventDefault();BotsModule.addTrustedPlayer();}" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.addTrustedPlayer()">${Lang.t('mcagent.cfg.trusted_add')}</button>
 </div>
 <div style="font-weight:600;font-size:13px;margin:14px 0 4px;">${Lang.t('mcagent.cfg.trade_title')}</div>
 <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${Lang.t('mcagent.cfg.trade_hint')}</div>
 <div style="display:flex;gap:6px;flex-wrap:wrap;">
 <input id="mca-e-trade-cmd" class="form-input" value="${this._escapeHtml(trade.acceptCmd || '')}" placeholder="${Lang.t('mcagent.cfg.trade_cmd_ph')}" style="max-width:200px;" />
 <input id="mca-e-trade-pat" class="form-input" value="${this._escapeHtml(trade.requestPattern || '')}" placeholder="${Lang.t('mcagent.cfg.trade_pattern_ph')}" style="flex:1;min-width:160px;" />
 </div>
 <div style="font-weight:600;font-size:13px;margin:14px 0 4px;">${Lang.t('mcagent.group.login_title')}</div>
 <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text-muted);cursor:pointer;margin-bottom:6px;">
 <input type="checkbox" id="mca-e-haslogin" ${e.has_login ? 'checked' : ''} onchange="BotsModule._toggleLoginCmd(this.checked)" /> ${Lang.t('mcagent.group.has_login')}
 </label>
 <div id="mca-e-logincmd-wrap" style="display:${e.has_login ? 'block' : 'none'};">
 <input id="mca-e-logincmd" class="form-input" value="${this._escapeHtml(e.login_command || '/login {pwd}')}" placeholder="/login {pwd}" style="max-width:280px;" />
 <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${Lang.t('mcagent.group.login_hint')}</div>
 </div>
 <div style="font-size:11px;color:var(--text-dim);margin-top:14px;padding-top:10px;border-top:1px solid var(--border);">${Lang.t('mcagent.cfg.key_shared_note')}</div>
 <div style="display:flex;gap:8px;margin-top:14px;">
 <button class="btn btn-primary" onclick="BotsModule.saveServerProfile()">${Lang.t('mcagent.cfg.srv_save')}</button>
 <button class="btn btn-ghost" onclick="BotsModule.cancelServerEdit()">${Lang.t('mcagent.cfg.srv_cancel')}</button>
 </div>
 </div>`;
 },

 _captureEditorState() {
 const e = this._mcaEditing;
 if (!e) return;
 const g = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
 if (g('mca-e-name') !== undefined) e.name = g('mca-e-name');
 if (g('mca-e-host') !== undefined) e.host = g('mca-e-host');
 if (g('mca-e-port') !== undefined) e.port = parseInt(g('mca-e-port'), 10) || e.port;
 if (g('mca-e-user') !== undefined) e.user = g('mca-e-user');
 if (g('mca-e-auth') !== undefined) e.auth = g('mca-e-auth');
 if (g('mca-e-intel') !== undefined) e.intelligence = g('mca-e-intel');
 if (g('mca-e-lang') !== undefined) e.language = g('mca-e-lang');
 const stl = document.getElementById('mca-e-stealth');
 if (stl) e.stealth = !!stl.checked;
 e.commands = Array.from(document.querySelectorAll('.mca-cmd-cb')).filter((cb) => cb.checked).map((cb) => cb.value);
 const tc = document.getElementById('mca-e-trade-cmd');
 const tp = document.getElementById('mca-e-trade-pat');
 if (tc || tp) e.trade = { acceptCmd: tc ? tc.value.trim() : '', requestPattern: tp ? tp.value.trim() : '' };
 const hl = document.getElementById('mca-e-haslogin');
 if (hl) e.has_login = !!hl.checked;
 const lc = document.getElementById('mca-e-logincmd');
 if (lc) e.login_command = lc.value.trim() || '/login {pwd}';
 },

 // Affiche/masque le champ commande de login selon la checkbox (sans re-render complet).
 _toggleLoginCmd(on) {
 const wrap = document.getElementById('mca-e-logincmd-wrap');
 if (wrap) wrap.style.display = on ? 'block' : 'none';
 },

 addCustomCommand() {
 const cmd = (document.getElementById('mca-e-ccmd').value || '').trim();
 if (!cmd.startsWith('/')) { Toast.error(Lang.t('mcagent.cfg.custom_need_slash')); return; }
 const syntax = (document.getElementById('mca-e-csyn').value || '').trim() || cmd;
 const desc = (document.getElementById('mca-e-cdesc').value || '').trim();
 this._captureEditorState();
 this._mcaEditing.custom = this._mcaEditing.custom || [];
 this._mcaEditing.custom.push({ cmd, syntax, desc });
 this._renderServerEditor();
 },

 removeCustomCommand(i) {
 this._captureEditorState();
 this._mcaEditing.custom.splice(i, 1);
 this._renderServerEditor();
 },

 addTrustedPlayer() {
 const inp = document.getElementById('mca-e-trusted-add');
 const name = (inp && inp.value || '').trim();
 if (!name) return;
 this._captureEditorState();
 this._mcaEditing.trusted = this._mcaEditing.trusted || [];
 if (!this._mcaEditing.trusted.some((t) => t.toLowerCase() === name.toLowerCase())) this._mcaEditing.trusted.push(name);
 this._renderServerEditor();
 },

 removeTrustedPlayer(i) {
 this._captureEditorState();
 this._mcaEditing.trusted.splice(i, 1);
 this._renderServerEditor();
 },

 async saveServerProfile() {
 this._captureEditorState();
 const e = this._mcaEditing;
 // On vient de la vue groupe (Modifier) si _mcaGroupId est posé ; sinon c'est « Créer un groupe ».
 const fromGroup = !!this._mcaGroupId;
 // ⚠️ Ne JAMAIS envoyer `bots` : le backend préserve le roster (les comptes sont gérés dans l'onglet Bots ouvriers).
 const trade = (e.trade && (e.trade.acceptCmd || '').trim()) ? { acceptCmd: e.trade.acceptCmd.trim(), requestPattern: (e.trade.requestPattern || '').trim() } : null;
 const payload = { name: e.name || 'Sans nom', host: e.host || '', port: e.port || 25565, user: e.user || 'TrainBot', auth: e.auth || 'offline', intelligence: e.intelligence || 'intermediaire', language: e.language || 'fr', stealth: !!e.stealth, commands: e.commands || [], custom: e.custom || [], trusted: e.trusted || [], trade, has_login: !!e.has_login, login_command: e.login_command || '/login {pwd}' };
 const url = e.id ? `/api/mc-agent/servers/${encodeURIComponent(e.id)}` : '/api/mc-agent/servers';
 const r = await Auth.apiCall(url, { method: e.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
 if (!r || !r.ok) { Toast.error(Lang.t('mcagent.cfg.srv_save_err')); return; }
 this._mcaEditing = null;
 if (fromGroup) {
  // Édition depuis la vue groupe → on FERME le panneau réglages et on revient à la vue groupe.
  this._mcaSettingsOpen = false;
  this._renderMCARoot();
 } else {
  // Création d'un groupe → liste niveau 1.
  this._mcaGroupId = null;
  this._mcaView = 'list';
  this._renderMCARoot();
 }
 },

 cancelServerEdit() {
 const fromGroup = !!this._mcaGroupId;
 this._mcaEditing = null;
 if (fromGroup) {
  // Annulation depuis la vue groupe → ferme le panneau réglages, retour à la vue groupe.
  this._mcaSettingsOpen = false;
  this._renderMCARoot();
 } else {
  this._mcaGroupId = null;
  this._mcaView = 'list';
  this._renderMCARoot();
 }
 },

 async deleteServerProfile(id) {
 if (!confirm(Lang.t('mcagent.cfg.srv_confirm_delete'))) return;
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
 if (r && r.ok) this.loadServerProfiles();
 else Toast.error(Lang.t('mcagent.cfg.srv_delete_err'));
 },

 // ============ MC AGENT — CARTE (mémoire de monde) ============
 // Viewer 100% frontend : lit GET /api/mc-agent/servers/{sid}/memory (worlds → biomes/caves/finds,
 // coords quantifiées sur grille 128 côté backend). Aucune logique bot ici.
 // Canvas top-down : x monde → droite, z monde → bas (nord en haut, convention F3 Minecraft).

 _mcaMap: null,

 _mcaMapState() {
 if (!this._mcaMap) this._mcaMap = {
 sid: null, world: null, data: null,
 view: { cx: 0, cz: 0, scale: 0.6 }, // centre (blocs monde) + zoom (px/bloc)
 hidden: {}, // couches masquées via la légende ('b:<biome>' / 'm:<matériau>' / 'caves')
 fitted: {}, // monde → true après auto-cadrage (on ne re-cadre jamais sous l'utilisateur)
 timer: null, drag: null, resize: null,
 };
 return this._mcaMap;
 },

 _mcaMapStop() {
 const m = this._mcaMap;
 if (!m) return;
 if (m.timer) { clearInterval(m.timer); m.timer = null; }
 if (m.resize) { window.removeEventListener('resize', m.resize); m.resize = null; }
 m.drag = null;
 },

 // ============ Task 11 — Onglet « Carte » scopé au groupe + section Cartographes ============
 // Viewer carte = même machinerie _mcaMap* MAIS scopé : m.sid = group.id figé (plus de
 // sélecteur de serveur). Sous la carte, roster des bots role==='mapper' (lancement individuel
 // + lancement de N cartographes via /servers/{sid}/mappers/start).
 async _renderGroupMap(group) {
 const body = document.getElementById('mca-tabbody');
 if (!body || !group) return;
 this._mcaMapStop();
 const m = this._mcaMapState();
 // scope : la carte ne montre QUE la mémoire de monde de ce groupe
 if (m.sid !== group.id) { m.sid = group.id; m.world = null; m.fitted = {}; m.hidden = {}; m.data = null; }
 const viewerOpen = !!this._mcaMapViewerOpen;
 // Contenu PRINCIPAL = gestion des cartographes. La carte n'est PAS inline : elle vit derrière
 // le bouton « Ouvrir la carte » (panneau dépliable). Auto-refresh + resize armés UNIQUEMENT
 // quand la carte est ouverte (cf. _openMapViewer).
 body.innerHTML = `
 <div style="border-bottom:1px solid var(--border);margin:0 0 14px;padding-bottom:14px;">
 <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
 <div style="font-weight:600;">${Lang.t('mcagent.map.mappers_title')}</div>
 <button class="btn ${viewerOpen ? 'btn-secondary' : 'btn-primary'} btn-sm" style="margin-left:auto;" aria-expanded="${viewerOpen}" onclick="BotsModule.toggleMapViewer()">${viewerOpen ? Lang.t('mcagent.map.close_map') : Lang.t('mcagent.map.open_map')}</button>
 </div>
 <div style="font-size:12px;color:var(--text-muted);">${Lang.t('mcagent.map.mappers_hint')}</div>
 </div>
 <div id="mca-map-viewer" style="display:${viewerOpen ? 'block' : 'none'};margin-bottom:18px;">
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
 <select id="mca-map-world" class="form-input" style="max-width:170px;" onchange="BotsModule._mcaMapPickWorld(this.value)"></select>
 <button class="btn btn-secondary btn-sm" onclick="BotsModule._mcaMapRefresh()">${Lang.t('mcagent.map.refresh')}</button>
 <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-muted);cursor:pointer;">
 <input type="checkbox" id="mca-map-auto" onchange="BotsModule._mcaMapAutoToggle(this.checked)" /> ${Lang.t('mcagent.map.auto')}
 </label>
 <button class="btn btn-ghost btn-sm" onclick="BotsModule._mcaMapFit(true)">${Lang.t('mcagent.map.recenter')}</button>
 <span id="mca-map-updated" style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);margin-left:auto;"></span>
 </div>
 <div style="position:relative;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#a8895c;">
 <canvas id="mca-map-canvas" style="display:block;width:100%;height:440px;cursor:grab;touch-action:none;"></canvas>
 <div id="mca-map-empty" style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:20px;color:#4a3216;font-weight:600;font-size:13px;pointer-events:none;"></div>
 <div id="mca-map-coords" style="position:absolute;left:16px;bottom:14px;font-family:var(--font-mono);font-size:11px;color:#f0e1b9;background:rgba(58,44,24,0.85);padding:2px 8px;border-radius:6px;pointer-events:none;"></div>
 </div>
 <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">${Lang.t('mcagent.map.hint')}</div>
 <div id="mca-map-legend" style="margin-top:10px;"></div>
 </div>
 <div id="mca-map-mappers"><div style="font-size:12px;color:var(--text-dim);">…</div></div>`;
 await this._reloadGroupMappers();
 if (viewerOpen) {
  // (Re)montage de la carte : bind canvas + 1ère charge + arme l'auto-refresh des cartographes.
  this._mcaMapBindCanvas();
  await this._mcaMapRefresh();
  // Police pixel des étiquettes : redraw quand elle arrive (fallback monospace en attendant).
  if (document.fonts && document.fonts.load) document.fonts.load('8px PSP').then(() => this._mcaMapDraw()).catch(() => {});
 }
 // Auto-refresh statut des cartographes (5s) tant que l'onglet map est visible — indépendant de la carte.
 this._mcaWorkersStop();
 this._mcaWorkersTimer = setInterval(() => {
  if (this._mcaGroupId && this._mcaGroupTab === 'map' && !this._mcaSettingsOpen && document.getElementById('mca-map-mappers')) BotsModule._refreshMappersStatus();
  else BotsModule._mcaWorkersStop();
 }, 5000);
 },

 // Ouvre/ferme la carte (panneau dépliable de l'onglet Mapping).
 // ⚠️ Les timers carte (m.timer auto-refresh) + le listener resize ne tournent QUE carte ouverte :
 //    _mcaMapStop() les coupe à la fermeture (pas de fuite de timer).
 toggleMapViewer() {
 this._mcaMapViewerOpen = !this._mcaMapViewerOpen;
 if (!this._mcaMapViewerOpen) this._mcaMapStop(); // coupe auto-refresh carte + resize
 const g = this._mcaGroup();
 if (g) this._renderGroupMap(g);
 },

 // Recharge groupe + sessions actives puis re-render du roster cartographes.
 async _reloadGroupMappers() {
 try {
  const r = await Auth.apiCall('/api/mc-agent/servers');
  const data = await r.json();
  this._mcaServers = data.servers || [];
 } catch (e) { this._mcaServers = this._mcaServers || []; }
 await this._loadActiveByServer();
 this._renderMappersBody();
 },

 async _refreshMappersStatus() {
 await this._loadActiveByServer();
 this._renderMappersBody();
 },

 _renderMappersBody() {
 const root = document.getElementById('mca-map-mappers');
 const g = this._mcaGroup();
 if (!root || !g) return;
 const mappers = (g.bots || []).filter((b) => b.role === 'mapper');
 const showForm = !!this._mcaMapperForm;
 const rows = mappers.map((b) => {
  const sess = this._botSession(b.username);
  const online = !!sess;
  const authBadge = `<span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);">${this._escapeHtml(b.auth || 'offline')}</span>`;
  const secretBadge = b.has_secret ? `<span class="badge" title="${Lang.t('mcagent.bot.secret_saved')}" style="margin-left:4px;">${Lang.t('mcagent.bot.secret_ok')}</span>` : '';
  const onlineBadge = online
   ? `<span class="badge online" style="margin-left:6px;">${Lang.t('mcagent.bot.online')} · #${this._escapeHtml(String(sess.id))}</span>`
   : `<span class="badge" style="margin-left:6px;">${Lang.t('mcagent.bot.offline')}</span>`;
  const actionBtn = online
   ? `<button class="btn btn-secondary btn-sm" onclick="BotsModule.stopMapperBot('${this._escapeHtml(String(sess.id))}')">${Lang.t('mcagent.bot.stop')}</button>`
   : `<button class="btn btn-primary btn-sm" onclick="BotsModule.startMapperBot('${this._escapeHtml(b.id)}')">${Lang.t('mcagent.bot.launch')}</button>`;
  return `
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
   <div>
    <div style="font-weight:600;font-family:var(--font-mono);">${this._escapeHtml(b.username)}${onlineBadge}</div>
    <div style="margin-top:2px;">${authBadge}${secretBadge}</div>
   </div>
   <div style="display:flex;gap:6px;">
    ${actionBtn}
    <button class="btn btn-ghost btn-sm" onclick="BotsModule.deleteMapperBot('${this._escapeHtml(b.id)}')">${Lang.t('mcagent.bot.delete')}</button>
   </div>
  </div>`;
 }).join('');
 root.innerHTML = `
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
  <label class="form-label" style="margin:0;">${Lang.t('mcagent.map.start_n')}</label>
  <input type="number" id="mca-map-count" min="1" max="20" value="2" class="form-input" style="max-width:90px;" />
  <button class="btn btn-primary btn-sm" onclick="BotsModule.startNMappers()">${Lang.t('mcagent.map.start_n_btn')}</button>
 </div>
 ${mappers.length ? rows : `<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">${Lang.t('mcagent.map.empty_roster')}</div>`}
 <div style="margin-top:8px;">
  ${showForm ? this._renderMapperForm(g) : `<button class="btn btn-secondary btn-sm" onclick="BotsModule.toggleMapperForm(true)">${Lang.t('mcagent.map.add')}</button>`}
 </div>`;
 if (showForm) this._wireMapperForm(g);
 },

 _renderMapperForm(g) {
 return `
 <div style="background:var(--bg-elev-3);border:1px solid var(--border);border-radius:10px;padding:14px;">
  <div style="font-weight:600;font-size:13px;margin-bottom:10px;">${Lang.t('mcagent.map.add_title')}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
   <div><label class="form-label">${Lang.t('mcagent.bot.username')}</label><input id="mca-mp-user" class="form-input" placeholder="${Lang.t('mcagent.bot.username_ph')}" /></div>
   <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label>
    <select id="mca-mp-auth" class="form-input" onchange="BotsModule._toggleMapperSecret()">
     <option value="offline">${Lang.t('mcagent.auth_offline')}</option>
     <option value="microsoft">${Lang.t('mcagent.auth_microsoft')}</option>
    </select></div>
  </div>
  <div id="mca-mp-secret-wrap" style="display:${g.has_login ? 'block' : 'none'};margin-top:10px;">
   <label class="form-label">${Lang.t('mcagent.bot.secret')}</label>
   <input id="mca-mp-secret" class="form-input" type="password" autocomplete="new-password" placeholder="${Lang.t('mcagent.bot.secret_ph')}" style="max-width:280px;" />
   <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${Lang.t('mcagent.bot.secret_hint')}</div>
  </div>
  <div style="display:flex;gap:8px;margin-top:14px;">
   <button class="btn btn-primary btn-sm" onclick="BotsModule.createMapperBot()">${Lang.t('mcagent.bot.create')}</button>
   <button class="btn btn-ghost btn-sm" onclick="BotsModule.toggleMapperForm(false)">${Lang.t('mcagent.cfg.srv_cancel')}</button>
  </div>
 </div>`;
 },

 _wireMapperForm(g) { this._toggleMapperSecret(); },

 _toggleMapperSecret() {
 const g = this._mcaGroup();
 const wrap = document.getElementById('mca-mp-secret-wrap');
 const authEl = document.getElementById('mca-mp-auth');
 if (!wrap || !authEl || !g) return;
 const show = !!g.has_login && authEl.value === 'offline';
 wrap.style.display = show ? 'block' : 'none';
 },

 toggleMapperForm(on) {
 this._mcaMapperForm = !!on;
 this._renderMappersBody();
 },

 async createMapperBot() {
 const g = this._mcaGroup();
 if (!g) return;
 const username = (document.getElementById('mca-mp-user') || {}).value;
 const auth = (document.getElementById('mca-mp-auth') || {}).value || 'offline';
 const u = (username || '').trim();
 if (!u) { Toast.error(Lang.t('mcagent.bot.username_required')); return; }
 const secretEl = document.getElementById('mca-mp-secret');
 const payload = { role: 'mapper', username: u, auth };
 if (g.has_login && auth === 'offline' && secretEl && secretEl.value) payload.secret = secretEl.value;
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(g.id)}/bots`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
 });
 const data = await (r ? r.json().catch(() => ({})) : Promise.resolve({}));
 if (!r || !r.ok) { Toast.error((data && data.detail) || Lang.t('mcagent.bot.create_err')); return; }
 this._mcaMapperForm = false;
 await this._reloadGroupMappers();
 },

 async deleteMapperBot(botId) {
 const g = this._mcaGroup();
 if (!g) return;
 const name = ((g.bots || []).find((b) => b.id === botId) || {}).username || '';
 if (!confirm(Lang.t('mcagent.bot.confirm_delete').replace('{name}', name))) return;
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(g.id)}/bots/${encodeURIComponent(botId)}`, { method: 'DELETE' });
 if (!r || !r.ok) { Toast.error(Lang.t('mcagent.bot.delete_err')); return; }
 await this._reloadGroupMappers();
 },

 async startMapperBot(botId) {
 const g = this._mcaGroup();
 if (!g) return;
 const r = await Auth.apiCall('/api/mc-agent/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ server_id: g.id, bot_id: botId, objective: 'mapper', autonomous: true }),
 });
 const data = await (r ? r.json().catch(() => ({})) : Promise.resolve({}));
 if (!r || !r.ok) { Toast.error((data && data.detail) || Lang.t('mcagent.bot.launch_err')); return; }
 await this._reloadGroupMappers();
 },

 async stopMapperBot(sessionId) {
 const r = await Auth.apiCall(`/api/mc-agent/stop/${encodeURIComponent(sessionId)}`, { method: 'POST' });
 if (!r || !r.ok) { Toast.error(Lang.t('mcagent.bot.stop_err')); return; }
 await this._reloadGroupMappers();
 },

 // Lance N cartographes d'un coup (comptes mapper offline disponibles).
 async startNMappers() {
 const g = this._mcaGroup();
 if (!g) return;
 const el = document.getElementById('mca-map-count');
 let count = parseInt((el && el.value) || '0', 10);
 if (!Number.isFinite(count) || count < 1) count = 1;
 if (count > 20) count = 20;
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(g.id)}/mappers/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count }),
 });
 const data = await (r ? r.json().catch(() => ({})) : Promise.resolve({}));
 if (!r || !r.ok) { Toast.error((data && data.detail) || Lang.t('mcagent.bot.launch_err')); return; }
 const launched = data.launched || 0;
 const available = (data.available != null) ? data.available : launched;
 let summary = Lang.t('mcagent.map.started').replace('{launched}', launched).replace('{available}', available);
 if (Array.isArray(data.skipped) && data.skipped.length) {
  summary += ' · ' + Lang.t('mcagent.map.skipped').replace('{names}', data.skipped.join(', '));
 }
 Toast.success(summary);
 if (launched < count) Toast.info(Lang.t('mcagent.map.need_more'));
 await this._reloadGroupMappers();
 },

 _mcaMapPickWorld(w) {
 const m = this._mcaMapState();
 m.world = w;
 this._mcaMapSync();
 },

 async _mcaMapRefresh() {
 const m = this._mcaMapState();
 if (!m.sid) return;
 try {
 const r = await Auth.apiCall(`/api/mc-agent/servers/${encodeURIComponent(m.sid)}/memory`);
 if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
 m.data = await r.json();
 } catch (e) {
 this._mcaMapShowEmpty(Lang.t('mcagent.map.load_err'));
 return;
 }
 this._mcaMapSync();
 },

 _mcaMapAutoToggle(on) {
 const m = this._mcaMapState();
 if (m.timer) { clearInterval(m.timer); m.timer = null; }
 // poll ~3s pour voir la carte se remplir en live pendant un run cartographe
 if (on) m.timer = setInterval(() => {
 if (document.getElementById('mca-map-canvas')) this._mcaMapRefresh();
 else this._mcaMapStop();
 }, 3000);
 },

 // Mondes vanilla d'abord dans un ordre stable, puis les labels custom (ex. "mining") alphabétiques.
 _mcaMapWorlds() {
 const m = this._mcaMapState();
 const keys = Object.keys((m.data && m.data.worlds) || {});
 const order = { overworld: 0, nether: 1, the_nether: 1, the_end: 2, end: 2 };
 return keys.sort((a, b) => ((a in order ? order[a] : 9) - (b in order ? order[b] : 9)) || a.localeCompare(b));
 },

 _mcaMapWorld() {
 const m = this._mcaMapState();
 return (m.data && m.data.worlds && m.world) ? m.data.worlds[m.world] : null;
 },

 _mcaMapSync() {
 const m = this._mcaMapState();
 const worlds = this._mcaMapWorlds();
 if (!m.world || !worlds.includes(m.world)) m.world = worlds[0] || null;
 const wsel = document.getElementById('mca-map-world');
 if (wsel) wsel.innerHTML = worlds.length
 ? worlds.map((w) => `<option value="${this._escapeHtml(w)}" ${w === m.world ? 'selected' : ''}>${this._escapeHtml(w)}</option>`).join('')
 : '<option value="">—</option>';
 const upd = document.getElementById('mca-map-updated');
 if (upd) {
 const at = m.data && m.data.updated_at;
 const locale = Lang.t('common.locale') || 'fr-FR';
 upd.textContent = `${Lang.t('mcagent.map.updated')}: ${at ? new Date(at).toLocaleString(locale) : Lang.t('mcagent.map.never')}`;
 }
 const world = this._mcaMapWorld();
 const has = !!world && ((world.biomes || []).length + (world.caves || []).length + (world.structures || []).length) > 0;
 this._mcaMapShowEmpty(has ? null : Lang.t('mcagent.map.empty'));
 if (has && m.world && !m.fitted[m.world]) this._mcaMapFit(false);
 this._mcaMapLegend();
 this._mcaMapDraw();
 },

 _mcaMapShowEmpty(msg) {
 const el = document.getElementById('mca-map-empty');
 if (!el) return;
 el.style.display = msg ? 'flex' : 'none';
 if (msg) el.textContent = msg;
 },

 // Cadre la vue sur l'étendue des données du monde courant (90% du canvas).
 _mcaMapFit(redraw) {
 const m = this._mcaMapState();
 const world = this._mcaMapWorld();
 const cv = document.getElementById('mca-map-canvas');
 if (!cv) return;
 let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
 const seen = (x, z, span) => {
 minX = Math.min(minX, x); maxX = Math.max(maxX, x + (span || 0));
 minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z + (span || 0));
 };
 if (world) {
 (world.biomes || []).forEach((b) => seen(b.x, b.z, 128));
 (world.caves || []).forEach((c) => seen(c.x, c.z, 0));
 (world.structures || []).forEach((st) => seen(st.x, st.z, 0));
 }
 if (minX === Infinity) { m.view = { cx: 0, cz: 0, scale: 0.6 }; if (redraw) this._mcaMapDraw(); return; }
 const w = cv.clientWidth || 800, h = cv.clientHeight || 440;
 m.view.cx = (minX + maxX) / 2;
 m.view.cz = (minZ + maxZ) / 2;
 const scale = Math.min(w / Math.max(maxX - minX, 128), h / Math.max(maxZ - minZ, 128)) * 0.9;
 m.view.scale = Math.min(4, Math.max(0.02, scale));
 if (m.world) m.fitted[m.world] = true;
 if (redraw) this._mcaMapDraw();
 },

 _mcaHash(s) {
 let h = 0;
 for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
 return Math.abs(h);
 },

 // Hash numérique rapide → [0,1) déterministe (grain/crans stables, pas de Math.random).
 _mcaHash2(a, b) {
 let h = ((a | 0) * 374761393 + (b | 0) * 668265263) | 0;
 h = ((h ^ (h >> 13)) * 1274126177) | 0;
 return ((h ^ (h >> 16)) >>> 0) / 4294967295;
 },

 // Multiplie la luminosité d'un '#rrggbb' (f ~ 0.8-1.2) → 'rgb(...)'.
 _mcaShade(hex, f) {
 const v = parseInt(hex.slice(1), 16);
 const r = Math.min(255, ((v >> 16) & 255) * f) | 0;
 const g = Math.min(255, ((v >> 8) & 255) * f) | 0;
 const b = Math.min(255, (v & 255) * f) | 0;
 return 'rgb(' + r + ',' + g + ',' + b + ')';
 },

 // Sprites 16×16 des structures (mockup 2026-07-14 direction A validé) — '.' = transparent.
 _MCA_SPRITES: {
 village: { p: { R: '#8a4a24', r: '#5e2f14', W: '#e8dcc4', F: '#7fb4d8', f: '#5a88b0', D: '#6b4423', d: '#3a250f', S: '#b8a878' }, g: [
 '................',
 '.......rr.......',
 '......rRRr......',
 '.....rRRRRr.....',
 '....rRRRRRRr....',
 '...rRRRRRRRRr...',
 '..rRRRRRRRRRRr..',
 '.rRRRRRRRRRRRRr.',
 '.rr..........rr.',
 '..WWFFWWWWDDWW..',
 '..WWFFWWWWDdWW..',
 '..WWffWWWWDDWW..',
 '..WWWWWWWWDdWW..',
 '..WWWWWWWWDDWW..',
 '..SSSSSSSSSSSS..',
 '................'] },
 dungeon: { p: { K: '#33333c', k: '#1b1b22', n: '#101016', y: '#ffd23e', o: '#ff8a2e' }, g: [
 '................',
 '..KKKKKKKKKKKK..',
 '..KnnKKnnKKnnK..',
 '..KnnKKnnKKnnK..',
 '..KKKKKKKKKKKK..',
 '..KnnKKyyKKnnK..',
 '..KnnKyyyyKnnK..',
 '..KKKKoyyoKKKK..',
 '..KnnKooooKnnK..',
 '..KnnKKooKKnnK..',
 '..KKKKKKKKKKKK..',
 '..KnnKKnnKKnnK..',
 '..KnnKKnnKKnnK..',
 '..KKKKKKKKKKKK..',
 '................',
 '................'] },
 monument: { p: { P: '#4fbfb2', D: '#2e7a73', d: '#16343a', L: '#d8f0e0' }, g: [
 '................',
 '......PPPP......',
 '....PPPPPPPP....',
 '..PPPPPPPPPPPP..',
 '..PDPPLLLLPPDP..',
 '..PDPPLPPLPPDP..',
 '..PDPPLLLLPPDP..',
 '..PDPPPPPPPPDP..',
 '..PDPPddddPPDP..',
 '..PDPPddddPPDP..',
 '..PPPPddddPPPP..',
 '..PPPPPPPPPPPP..',
 '................',
 '................',
 '................',
 '................'] },
 mineshaft: { p: { B: '#8a5a2b', b: '#6e4520', n: '#17120c', T: '#5c3a1e', M: '#b8bec6', s: '#3a2c1a' }, g: [
 '................',
 '..BBBBBBBBBBBB..',
 '..BbBBBBBBBBbB..',
 '..BbnnnnnnnnbB..',
 '..BbnnnnnnnnbB..',
 '..BbnnnnnnnnbB..',
 '..BbnnnnnnnnbB..',
 '..BbnnnnnnnnbB..',
 '..BbnnnnnnnnbB..',
 '..ssssssssssss..',
 '..sTsMMsMMsTss..',
 '..ssssssssssss..',
 '................',
 '................',
 '................',
 '................'] },
 stronghold: { p: { P: '#2c1f3e', G: '#6fae2e', g: '#b8e07a', n: '#0c0a12' }, g: [
 '................',
 '................',
 '................',
 '.....PPPPPP.....',
 '...PPGGGGGGPP...',
 '..PGGGggggGGGP..',
 '.PGGgggnnggggGP.',
 '.PGGggnnnnggGGP.',
 '.PGGgggnnggggGP.',
 '..PGGGggggGGGP..',
 '...PPGGGGGGPP...',
 '.....PPPPPP.....',
 '................',
 '................',
 '................',
 '................'] },
 ancient_city: { p: { W: '#2c3a44', w: '#48606e', C: '#22d3ee', s: '#0e5a5a' }, g: [
 '................',
 '..ww........ww..',
 '..wWw......wWw..',
 '...WWWWWWWWWW...',
 '..WWWWWWWWWWWW..',
 '..WWCCWWWWCCWW..',
 '..WWCCWWWWCCWW..',
 '..WWWWWWWWWWWW..',
 '..WWWssssssWWW..',
 '..WWssssssssWW..',
 '..WWWWWWWWWWWW..',
 '...WWWWWWWWWW...',
 '................',
 '................',
 '................',
 '................'] },
 ruined_portal: { p: { O: '#241b33', C: '#6a4fd0', v: '#8a5aff', G: '#f5c542' }, g: [
 '................',
 '..OOOOOOOOO.....',
 '..OO.....OO.....',
 '..OO.vvv........',
 '..CC.vvvv...OO..',
 '..OO.vvvv...OO..',
 '..OO.vvvv...CC..',
 '..CC.vvvv...OO..',
 '..OO.vvvv...OO..',
 '..OOOOOOOOOOOO..',
 '..GG........GG..',
 '................',
 '................',
 '................',
 '................',
 '................'] },
 desert_pyramid: { p: { S: '#ead9a0', s: '#c9b87e', O: '#c77b33', d: '#3c2f1a' }, g: [
 '................',
 '.......SS.......',
 '......SsSS......',
 '.....SSSSSS.....',
 '....SSsOOsSS....',
 '...SSSSOOSSSS...',
 '..SSsSSSSSSsSS..',
 '.SSSSSooooSSSSS.',
 '.SSsSSoddoSSsSS.',
 'SSSSSSoddoSSSSSS',
 'SsSSsSSSSSSsSSsS',
 '................',
 '................',
 '................',
 '................',
 '................'] },
 jungle_pyramid: { p: { C: '#7a8a78', c: '#5f6e5e', m: '#4e7a3a', d: '#1e2a1a', v: '#3e6a2e' }, g: [
 '................',
 '.....CCCCCC.....',
 '.....CmCCmC.....',
 '....CCCCCCCC....',
 '...CCmCccCmCC...',
 '...CCCCddCCCC...',
 '..CCmCCddCCmCC..',
 '..CcCCCddCCCcC..',
 '.CCCCCCddCCCCCC.',
 '.vCCmCCCCCCmCCv.',
 '.v...v.....v..v.',
 '.v...v........v.',
 '................',
 '................',
 '................',
 '................'] },
 pillager_outpost: { p: { D: '#3c2f1e', B: '#8a5a2b', b: '#a06c36', n: '#141008', F: '#5c6670' }, g: [
 '................',
 '....DDDDDDDD....',
 '....DBBBBBBD....',
 '....BnBBBBnBFF..',
 '....BBBBBBBBF...',
 '.....BbbbbB.F...',
 '.....BbbbbB.....',
 '.....BbnbbB.....',
 '.....BbbbbB.....',
 '.....BbbbbB.....',
 '.....BbnbbB.....',
 '....BBBBBBBB....',
 '................',
 '................',
 '................',
 '................'] },
 shipwreck: { p: { H: '#6e4a26', h: '#4a2f16', M: '#8a5a2b', S: '#d8cba8' }, g: [
 '................',
 '......M.........',
 '......MM........',
 '......M.S.......',
 '......M.SS......',
 '......MMSSS.....',
 '......MM.SS.....',
 '......MM........',
 '.HH...MM....HH..',
 '.HHHHHHHHHHHHH..',
 '..HHHHHHHHHHH...',
 '...HHHHHHHHH....',
 '....hhhhhhh.....',
 '................',
 '................',
 '................'] },
 fortress: { p: { N: '#4a2230', n: '#1c0c12', a: '#ff7a2e' }, g: [
 '................',
 '..NN..NN..NN....',
 '..NNNNNNNNNNNN..',
 '..NNNNNNNNNNNN..',
 '..NNaaNNNNaaNN..',
 '..NNNNNNNNNNNN..',
 '..NNNNnnnnNNNN..',
 '..NNNNnnnnNNNN..',
 '..NNNNnnnnNNNN..',
 '..NNNNnaannNNNN.',
 '..NNNNNNNNNNNN..',
 '................',
 '................',
 '................',
 '................',
 '................'] },
 cave: { p: { G: '#8a8f95', g: '#5f646b', n: '#0c0e12' }, g: [
 '................',
 '................',
 '................',
 '.....GGGGGG.....',
 '...GGgGGGGgGG...',
 '..GGnnnnnnnnGG..',
 '..GgnnnnnnnngG..',
 '.GGnnnnnnnnnnGG.',
 '.GgnnnnnnnnnnGG.',
 '.GGnnnnnnnnnngG.',
 '................',
 '................',
 '................',
 '................',
 '................',
 '................'] }
 },

 // Dessine un sprite 16×16 centré en (cx,cy), s px par pixel, ombre portée dure optionnelle.
 _mcaDrawSprite(ctx, name, cx, cy, s, withShadow) {
 const d = this._MCA_SPRITES[name];
 if (!d) return false;
 const g = d.g, p = d.p, ox = cx - 8 * s, oy = cy - 8 * s;
 if (withShadow) {
 ctx.fillStyle = 'rgba(0,0,0,0.45)';
 for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
 const ch = g[y] && g[y][x];
 if (ch && ch !== '.') ctx.fillRect(ox + x * s + s, oy + y * s + s, s, s);
 }
 }
 for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
 const ch = g[y] && g[y][x];
 if (ch && ch !== '.' && p[ch]) { ctx.fillStyle = p[ch]; ctx.fillRect(ox + x * s, oy + y * s, s, s); }
 }
 return true;
 },

 // Couleur stable par biome — map colors « item carte » MC + jitter de luminosité hashé (±4 %)
 // pour distinguer les variantes ; fallback palette terre pour les biomes custom de datapack.
 _MCA_BIOME_RULES: [
 // ⚠️ l'ORDRE compte : crimson/warped avant /forest/, badland avant /desert/, deep_dark avant /cave/
 [/crimson/, '#943F3F'],
 [/warped/, '#2E7A73'],
 [/nether|basalt|soul|magma|delta/, '#7A3327'],
 [/lush/, '#4C9E4C'],
 [/deep_dark|sculk/, '#10344A'],
 [/dripstone/, '#976D4D'],
 [/ocean|river|water|aquifer/, '#4040F0'],
 [/frozen|snow|ice|grove/, '#D8E2D8'],
 [/badland/, '#D87F33'],
 [/desert|beach|sand|dune/, '#F7E9A3'],
 [/jungle|bamboo/, '#2C9E1A'],
 [/swamp|mangrove|bog/, '#62703A'],
 [/savanna/, '#B8A94E'],
 [/taiga/, '#5C8A5A'],
 [/forest|wood|birch|cherry/, '#4C8A2E'],
 [/plain|meadow|field|pasture/, '#8AB84F'],
 [/mushroom/, '#8F7748'],
 [/peak|mountain|hill|slope|stony|windswept|gravel/, '#7A7A7A'],
 [/\bend\b|void|barren/, '#D8D0A8'],
 [/cave|deep/, '#5A4D3A'],
 ],

 _MCA_BIOME_FALLBACK: ['#8AB84F', '#976D4D', '#B8A94E', '#5C8A5A', '#7A7A7A', '#62703A'],

 // Couleur map-color de BASE ('#rrggbb') d'un biome — sans jitter (le grain shade la base).
 _mcaBiomeBase(name) {
 const n = String(name).toLowerCase();
 for (const [re, hex] of this._MCA_BIOME_RULES) {
 if (re.test(n)) return hex;
 }
 return this._MCA_BIOME_FALLBACK[this._mcaHash('b:' + n) % this._MCA_BIOME_FALLBACK.length];
 },

 _mcaBiomeColor(name) {
 const jitter = 0.96 + (this._mcaHash('b:' + String(name).toLowerCase()) % 9) / 100;
 return this._mcaShade(this._mcaBiomeBase(name), jitter);
 },

 // Couleurs fixes pour les matériaux courants (lisibilité immédiate), hash vif pour le reste.
 _MCA_MAT_COLORS: {
 diamond: '#4DD8E6', diamond_ore: '#4DD8E6', deepslate_diamond_ore: '#4DD8E6',
 iron: '#E8C5A8', iron_ore: '#E8C5A8', deepslate_iron_ore: '#E8C5A8', raw_iron: '#E8C5A8',
 coal: '#9AA0A6', coal_ore: '#9AA0A6', deepslate_coal_ore: '#9AA0A6',
 copper_ore: '#E77C56', gold_ore: '#FACC15', redstone_ore: '#F87171',
 lapis_ore: '#60A5FA', emerald_ore: '#4ADE80',
 },

 _mcaMatColor(mat) {
 const key = String(mat).toLowerCase();
 if (this._MCA_MAT_COLORS[key]) return this._MCA_MAT_COLORS[key];
 if (/log|wood|plank/.test(key)) return '#B08968';
 const h = this._mcaHash('m:' + key);
 return `hsl(${h % 360},80%,64%)`;
 },

 _mcaMapBindCanvas() {
 const m = this._mcaMapState();
 const cv = document.getElementById('mca-map-canvas');
 if (!cv) return;
 m.resize = () => this._mcaMapDraw();
 window.addEventListener('resize', m.resize);
 const pos = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
 cv.addEventListener('pointerdown', (ev) => {
 ev.preventDefault();
 cv.setPointerCapture(ev.pointerId);
 const p = pos(ev);
 m.drag = { x: p.x, y: p.y, cx: m.view.cx, cz: m.view.cz };
 cv.style.cursor = 'grabbing';
 });
 cv.addEventListener('pointermove', (ev) => {
 const p = pos(ev);
 if (m.drag) {
 m.view.cx = m.drag.cx - (p.x - m.drag.x) / m.view.scale;
 m.view.cz = m.drag.cz - (p.y - m.drag.y) / m.view.scale;
 this._mcaMapDraw();
 }
 this._mcaMapCoords(p, cv);
 });
 const end = () => { m.drag = null; cv.style.cursor = 'grab'; };
 cv.addEventListener('pointerup', end);
 cv.addEventListener('pointercancel', end);
 cv.addEventListener('pointerleave', () => {
 const el = document.getElementById('mca-map-coords');
 if (el) el.textContent = '';
 });
 cv.addEventListener('wheel', (ev) => {
 ev.preventDefault();
 const p = pos(ev);
 const w = cv.clientWidth, h = cv.clientHeight;
 const v = m.view;
 // zoom centré sur le curseur : le point monde sous la souris reste sous la souris
 const wx = v.cx + (p.x - w / 2) / v.scale;
 const wz = v.cz + (p.y - h / 2) / v.scale;
 v.scale = Math.min(8, Math.max(0.02, v.scale * Math.exp(-ev.deltaY * 0.0015)));
 v.cx = wx - (p.x - w / 2) / v.scale;
 v.cz = wz - (p.y - h / 2) / v.scale;
 this._mcaMapDraw();
 this._mcaMapCoords(p, cv);
 }, { passive: false });
 },

 // Coords monde sous le curseur + biome de la cellule + structure/grotte proche (< 14 px écran).
 _mcaMapCoords(p, cv) {
 const el = document.getElementById('mca-map-coords');
 if (!el) return;
 const v = this._mcaMapState().view;
 const w = cv.clientWidth, h = cv.clientHeight;
 const wx = Math.round(v.cx + (p.x - w / 2) / v.scale);
 const wz = Math.round(v.cz + (p.y - h / 2) / v.scale);
 const cx = Math.floor(wx / 128) * 128, cz = Math.floor(wz / 128) * 128;
 const world = this._mcaMapWorld();
 const b = world ? (world.biomes || []).find((bb) => bb.x === cx && bb.z === cz) : null;
 let near = '';
 if (world) {
 const sx = (o) => (o.x - v.cx) * v.scale + w / 2;
 const sy = (o) => (o.z - v.cz) * v.scale + h / 2;
 let best = 14;
 for (const st of world.structures || []) {
 const d = Math.hypot(sx(st) - p.x, sy(st) - p.y);
 if (d < best) { best = d; near = this._mcaStructName(st.kind); }
 }
 for (const c of world.caves || []) {
 const d = Math.hypot(sx(c) - p.x, sy(c) - p.y);
 if (d < best) { best = d; near = this._mcaStructName('cave') + (typeof c.y === 'number' ? ' y ' + c.y : ''); }
 }
 }
 el.textContent = `x ${wx} · z ${wz}` + (b ? ` · ${b.name || ('#' + b.id)}` : '') + (near ? ` · ${near}` : '');
 },

 // Rendu « item carte » MC : parchemin, biomes map-colors + grain dithéré, curseur de spawn,
 // sprites de structures/grottes avec labels au zoom. Les « trouvailles » (mémoire interne
 // du bot) ne sont PAS dessinées.
 _mcaMapDraw() {
 const m = this._mcaMapState();
 const cv = document.getElementById('mca-map-canvas');
 if (!cv) return;
 const dpr = window.devicePixelRatio || 1;
 const w = cv.clientWidth, h = cv.clientHeight;
 if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
 cv.width = Math.round(w * dpr);
 cv.height = Math.round(h * dpr);
 }
 const ctx = cv.getContext('2d');
 ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
 // parchemin nu = zone pas encore cartographiée
 ctx.fillStyle = '#d4bb8d';
 ctx.fillRect(0, 0, w, h);
 const v = m.view;
 const toX = (x) => (x - v.cx) * v.scale + w / 2;
 const toY = (z) => (z - v.cz) * v.scale + h / 2;
 const world = this._mcaMapWorld();
 if (!world) { this._mcaMapScaleBar(ctx, w, h); this._mcaFrame(ctx, w, h); return; }
 const hid = m.hidden;
 // 1. biomes — cases 128×128 en map colors + grain dithéré déterministe (stable au redraw)
 const cell = 128 * v.scale;
 for (const b of world.biomes || []) {
 const key = b.name || ('#' + b.id);
 if (hid['b:' + key]) continue;
 const x0 = toX(b.x), y0 = toY(b.z);
 if (x0 > w || y0 > h || x0 + cell < 0 || y0 + cell < 0) continue;
 const baseHex = this._mcaBiomeBase(key);
 const jitter = 0.96 + (this._mcaHash('b:' + String(key).toLowerCase()) % 9) / 100;
 ctx.fillStyle = this._mcaShade(baseHex, jitter);
 ctx.fillRect(x0, y0, cell + 0.5, cell + 0.5);
 if (cell >= 12) {
 const g = Math.max(6, cell / 16); // ≤ ~256 sous-tuiles par cellule (garde-fou perf)
 const cellX = Math.round(b.x / 128), cellZ = Math.round(b.z / 128);
 for (let gy = 0, iy = 0; gy < cell; gy += g, iy++) {
 for (let gx = 0, ix = 0; gx < cell; gx += g, ix++) {
 const r = this._mcaHash2(cellX * 97 + ix, cellZ * 131 + iy);
 const f = r < 0.22 ? 0.92 : (r > 0.82 ? 1.07 : 0);
 if (f) {
 ctx.fillStyle = this._mcaShade(baseHex, jitter * f);
 ctx.fillRect(x0 + gx, y0 + gy, Math.min(g, cell - gx), Math.min(g, cell - gy));
 }
 }
 }
 }
 }
 // 2. grille 128 discrète, encre brune (si assez zoomé pour qu'elle ait un sens)
 if (v.scale >= 0.12) {
 ctx.strokeStyle = 'rgba(90,60,20,0.07)';
 ctx.lineWidth = 1;
 const step = cell;
 let gx = toX(Math.floor((v.cx - w / 2 / v.scale) / 128) * 128);
 for (; gx <= w; gx += step) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
 let gy = toY(Math.floor((v.cz - h / 2 / v.scale) / 128) * 128);
 for (; gy <= h; gy += step) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
 }
 // 3. spawn (0,0) — curseur de map MC (losange blanc contour noir)
 const ox = toX(0), oy = toY(0);
 if (ox >= -10 && ox <= w + 10 && oy >= -10 && oy <= h + 10) {
 ctx.save();
 ctx.translate(ox, oy);
 ctx.rotate(Math.PI / 4);
 ctx.fillStyle = '#ffffff';
 ctx.strokeStyle = '#1a1a1a';
 ctx.lineWidth = 2;
 ctx.beginPath();
 ctx.rect(-5, -5, 10, 10);
 ctx.fill();
 ctx.stroke();
 ctx.restore();
 }
 // 4. grottes — sprite « cave » (tooltip au survol, pas de label)
 if (!hid.caves) {
 for (const c of world.caves || []) {
 const x = toX(c.x), y = toY(c.z);
 if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
 this._mcaDrawSprite(ctx, 'cave', x, y, 2, true);
 }
 }
 // 5. structures — sprite dédié + label parchemin au zoom ; kind inconnu → pastille+initiale
 const showLabels = cell >= 45;
 for (const st of world.structures || []) {
 if (hid['s:' + st.kind]) continue;
 const x = toX(st.x), y = toY(st.z);
 if (x < -24 || y < -24 || x > w + 24 || y > h + 24) continue;
 if (this._mcaDrawSprite(ctx, st.kind, x, y, 2, true)) {
 if (showLabels) this._mcaLabel(ctx, x + 22, y, this._mcaStructName(st.kind));
 } else {
 const col = this._structColor(st.kind);
 ctx.fillStyle = col;
 ctx.beginPath();
 ctx.arc(x, y, 6, 0, Math.PI * 2);
 ctx.fill();
 ctx.strokeStyle = 'rgba(26,20,10,0.9)';
 ctx.lineWidth = 1.2;
 ctx.stroke();
 ctx.fillStyle = '#1a140a';
 ctx.font = 'bold 8px monospace';
 ctx.textAlign = 'center';
 ctx.textBaseline = 'middle';
 ctx.fillText(this._structInitial(st.kind), x, y + 0.5);
 ctx.textAlign = 'left';
 if (showLabels) this._mcaLabel(ctx, x + 12, y, this._mcaStructName(st.kind));
 }
 }
 this._mcaMapScaleBar(ctx, w, h);
 this._mcaFrame(ctx, w, h);
 },

 // Barre d'échelle (bas-droite) : longueur en blocs, puissance de 2 calée sur 40-180px.
 _mcaMapScaleBar(ctx, w, h) {
 const v = this._mcaMapState().view;
 let blocks = 128;
 let px = blocks * v.scale;
 while (px < 40 && blocks < 65536) { blocks *= 2; px = blocks * v.scale; }
 while (px > 180 && blocks > 16) { blocks /= 2; px = blocks * v.scale; }
 const x = w - px - 26, y = h - 26;
 ctx.strokeStyle = 'rgba(74,50,22,0.85)';
 ctx.lineWidth = 1.5;
 ctx.beginPath();
 ctx.moveTo(x, y); ctx.lineTo(x + px, y);
 ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
 ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
 ctx.stroke();
 ctx.fillStyle = 'rgba(74,50,22,0.9)';
 ctx.font = '8px PSP, monospace'; // ctx.font ne résout pas les vars CSS
 ctx.textAlign = 'center';
 ctx.fillText(String(blocks), x + px / 2, y - 8);
 ctx.textAlign = 'left';
 },

 // Cadre « item carte » : pourtour parchemin sombre + crans pixel déterministes + liseré.
 _mcaFrame(ctx, w, h) {
 const k = 6, p = 12;
 ctx.fillStyle = '#a8895c';
 ctx.fillRect(0, 0, w, p);
 ctx.fillRect(0, h - p, w, p);
 ctx.fillRect(0, 0, p, h);
 ctx.fillRect(w - p, 0, p, h);
 for (let x = 0; x < w; x += k) {
 if (this._mcaHash2(x, 11) > 0.55) ctx.fillRect(x, p, k, k);
 if (this._mcaHash2(x, 13) > 0.55) ctx.fillRect(x, h - p - k, k, k);
 }
 for (let y = 0; y < h; y += k) {
 if (this._mcaHash2(15, y) > 0.55) ctx.fillRect(p, y, k, k);
 if (this._mcaHash2(17, y) > 0.55) ctx.fillRect(w - p - k, y, k, k);
 }
 ctx.strokeStyle = 'rgba(74,50,22,0.55)';
 ctx.lineWidth = 2;
 ctx.strokeRect(p + 2.5, p + 2.5, w - 2 * p - 5, h - 2 * p - 5);
 },

 // Étiquette parchemin : nom de structure à droite de l'icône (police pixel 8px).
 _mcaLabel(ctx, x, y, text) {
 ctx.font = '8px PSP, monospace';
 ctx.textAlign = 'left';
 ctx.textBaseline = 'middle';
 const tw = ctx.measureText(text).width;
 ctx.fillStyle = 'rgba(240,225,185,0.92)';
 ctx.strokeStyle = 'rgba(90,60,20,0.45)';
 ctx.lineWidth = 1;
 if (ctx.roundRect) {
 ctx.beginPath();
 ctx.roundRect(x, y - 8, tw + 12, 16, 4);
 ctx.fill();
 ctx.stroke();
 } else {
 ctx.fillRect(x, y - 8, tw + 12, 16);
 ctx.strokeRect(x + 0.5, y - 7.5, tw + 11, 15);
 }
 ctx.fillStyle = '#4a3216';
 ctx.fillText(text, x + 6, y + 1);
 },

 // Légende cliquable : chips biomes (carrés) / matériaux (losanges) / grottes (triangle) avec compte.
 _mcaMapLegend() {
 const box = document.getElementById('mca-map-legend');
 if (!box) return;
 const m = this._mcaMapState();
 const world = this._mcaMapWorld();
 if (!world) { box.innerHTML = ''; return; }
 const counts = (arr, key) => {
 const o = {};
 (arr || []).forEach((e) => { const k = key(e); o[k] = (o[k] || 0) + 1; });
 return o;
 };
 const biomes = counts(world.biomes, (b) => b.name || ('#' + b.id));
 const mats = counts(world.finds, (f) => f.material);
 const structCounts = counts(world.structures, (st) => st.kind);
 const chip = (k, label, color, count, shape) => {
 const sw = shape === 'diamond'
 ? `<span style="display:inline-block;width:9px;height:9px;background:${color};transform:rotate(45deg);border-radius:2px;"></span>`
 : shape === 'tri'
 ? `<span style="display:inline-block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid ${color};"></span>`
 : `<span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:3px;"></span>`;
 return `<button type="button" data-k="${this._escapeHtml(k)}" class="mca-map-chip" style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;margin:2px 6px 2px 0;font-size:12px;cursor:pointer;color:var(--text);opacity:${m.hidden[k] ? 0.35 : 1};">${sw}<span>${this._escapeHtml(label)}</span><span style="color:var(--text-dim);font-family:var(--font-mono);">${count}</span></button>`;
 };
 const bioChips = Object.keys(biomes).sort((a, b) => biomes[b] - biomes[a] || a.localeCompare(b))
 .map((k) => chip('b:' + k, k, this._mcaBiomeColor(k), biomes[k])).join('');
 const matChips = Object.keys(mats).sort()
 .map((k) => chip('m:' + k, k, this._mcaMatColor(k), mats[k], 'diamond')).join('');
 const structChips = Object.keys(structCounts).sort()
 .map((k) => chip('s:' + k, k.replace(/_/g, ' '), this._structColor(k), structCounts[k])).join('');
 const caveChip = (world.caves || []).length
 ? chip('caves', Lang.t('mcagent.map.caves'), '#F4F4F5', (world.caves || []).length, 'tri') : '';
 const section = (title, chips) => chips
 ? `<div style="margin-bottom:6px;"><div style="font-size:11px;text-transform:uppercase;color:var(--text-dim);margin-bottom:3px;">${title}</div>${chips}</div>` : '';
 box.innerHTML =
 section(Lang.t('mcagent.map.biomes'), bioChips) +
 section(Lang.t('mcagent.map.structures'), structChips) +
 section(Lang.t('mcagent.map.finds'), matChips) +
 section(Lang.t('mcagent.map.caves'), caveChip);
 box.querySelectorAll('.mca-map-chip').forEach((el) => el.addEventListener('click', () => {
 const k = el.getAttribute('data-k');
 m.hidden[k] = !m.hidden[k];
 el.style.opacity = m.hidden[k] ? 0.35 : 1;
 this._mcaMapDraw();
 }));
 },

 async refreshMCAgent() {
 if (!this._mcAgentSession) return;
 const r = await Auth.apiCall(`/api/mc-agent/chat/${this._mcAgentSession}`);
 if (!r || !r.ok) return;
 const data = await r.json();
 const box = document.getElementById('mca-transcript');
 if (!box) { clearInterval(this._mcAgentTimer); this._mcAgentTimer = null; return; }
 // échappe le contenu joueur (chat MC arbitraire) avant innerHTML — anti-XSS
 const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
 box.innerHTML = (data.transcript || []).map((e) =>
 e.type === 'say'
 ? `<div style="color:var(--accent);">[bot] ${esc(e.message)}</div>`
 : e.type === 'msa'
 ? `<div style="color:var(--warning);font-weight:600;">[microsoft] ${esc(e.message)}</div>`
 : `<div>&lt;${esc(e.from || '?')}&gt; ${esc(e.message)}</div>`
 ).join('');
 box.scrollTop = box.scrollHeight;
 },

 async sayMCAgent() {
 if (!this._mcAgentSession) return;
 const input = document.getElementById('mca-say');
 const message = input.value.trim();
 if (!message) return;
 await Auth.apiCall(`/api/mc-agent/say/${this._mcAgentSession}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ message }),
 });
 input.value = '';
 },

 async stopMCAgent() {
 if (!this._mcAgentSession) return;
 await Auth.apiCall(`/api/mc-agent/stop/${this._mcAgentSession}`, { method: 'POST' });
 clearInterval(this._mcAgentTimer);
 this._mcAgentTimer = null;
 const msg = document.getElementById('mca-msg');
 if (msg) msg.textContent = Lang.t('mcagent.stopped');
 this._mcAgentSession = null;
 },

 // Libellé d'un profil traduit par id (fallback texte backend si clé i18n absente — piège #12).
 _mcaProfileLabel(id, fb) {
 const key = 'mcagent.profiles.' + id;
 const v = Lang.t(key);
 return v === key ? (fb || id) : v;
 },
 // Tell #idx d'un profil traduit par id (fallback texte backend si clé i18n absente).
 _mcaProfileTell(id, idx, fb) {
 const key = 'mcagent.tells.' + id + '.' + idx;
 const v = Lang.t(key);
 return v === key ? fb : v;
 },

 async loadMCAgentProfiles() {
 const sel = document.getElementById('mca-profile');
 if (!sel) return;
 try {
 const r = await Auth.apiCall('/api/mc-agent/profiles');
 if (!r.ok) return;
 const data = await r.json();
 this._mcAgentProfiles = data.profiles || [];
 } catch (e) { this._mcAgentProfiles = []; }
 const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
 sel.innerHTML = (this._mcAgentProfiles || []).map((p) =>
 `<option value="${esc(p.id)}">${esc(this._mcaProfileLabel(p.id, p.label))} (${esc(Lang.t('mcagent.level_abbr'))} ${esc(p.level)})</option>`
 ).join('');
 const def = (this._mcAgentProfiles || []).find((p) => p.id === 'intermediaire');
 if (def) sel.value = 'intermediaire';
 this.renderMCAgentTells();
 },

 renderMCAgentTells() {
 const sel = document.getElementById('mca-profile');
 const box = document.getElementById('mca-tells');
 if (!sel || !box) return;
 const prof = (this._mcAgentProfiles || []).find((p) => p.id === sel.value);
 if (!prof || !Array.isArray(prof.tells) || !prof.tells.length) { box.style.display = 'none'; return; }
 const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
 box.style.display = 'block';
 box.innerHTML =
 `<div style="font-weight:600;color:var(--text);margin-bottom:6px;">${esc(Lang.t('mcagent.tells_title'))} — ${esc(this._mcaProfileLabel(prof.id, prof.label))}</div>` +
 `<ul style="margin:0;padding-left:18px;">` +
 prof.tells.map((t, i) => `<li style="margin:2px 0;">${esc(this._mcaProfileTell(prof.id, i, t))}</li>`).join('') +
 `</ul>`;
 },

 async _loadMCAgentKey() {
 const statusEl = document.getElementById('mca-key-status');
 if (!statusEl) return;
 const r = await Auth.apiCall('/api/mc-agent/settings/api-key');
 if (!r || !r.ok) { statusEl.textContent = ''; return; }
 const data = await r.json();
 statusEl.textContent = data.has_key ? `${Lang.t('mcagent.key_set')} (${data.preview})` : Lang.t('mcagent.key_absent');
 statusEl.style.color = data.has_key ? 'var(--accent)' : 'var(--text-muted)';
 },

 async saveMCAgentKey() {
 const input = document.getElementById('mca-key');
 const key = input.value.trim();
 if (!key) return;
 const r = await Auth.apiCall('/api/mc-agent/settings/api-key', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ key }),
 });
 if (!r) return;
 const data = await r.json().catch(() => ({}));
 if (!r.ok) { Toast.error(data.detail || Lang.t('mcagent.key_invalid')); return; }
 input.value = '';
 Toast.success(Lang.t('mcagent.key_saved'));
 this._loadMCAgentKey();
 },

 async clearMCAgentKey() {
 const r = await Auth.apiCall('/api/mc-agent/settings/api-key', { method: 'DELETE' });
 if (r && r.ok) { Toast.success(Lang.t('mcagent.key_cleared')); this._loadMCAgentKey(); }
 },

 _escapeHtml(s) {
 return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
 { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
 },

 async loadCaptures() {
 const box = document.getElementById('mca-captures');
 if (!box) return;
 try {
 const r = await Auth.apiCall('/api/mc-agent/captures');
 const data = await r.json();
 const caps = (data && data.captures) || [];
 if (!caps.length) { box.innerHTML = `<div style="font-size:12px;color:var(--text-dim);">${Lang.t('mcagent.capture_none')}</div>`; return; }
 box.innerHTML = caps.map((c) => {
 const p = this._escapeHtml(c.player);
 const mb = (c.bytes / 1048576).toFixed(1);
 return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">
 <span style="font-family:var(--font-mono);">${p} — ${c.sessions} ${Lang.t('mcagent.capture_sessions')} (${mb} Mo)</span>
 <span style="display:flex;gap:6px;">
 ${this._mcaRecTester ? '' : `<button class="btn btn-ghost btn-sm" onclick="BotsModule.distillCapture('${p}')">${Lang.t('mcagent.capture_distill')}</button>`}
 ${(c.files || []).map((f) => `<button class="btn btn-ghost btn-sm" onclick="BotsModule.deleteSession('${p}','${this._escapeHtml(f)}')" title="${this._escapeHtml(f)}">${Lang.t('mcagent.capture_delete')}</button>`).join('')}
 </span></div>
 <div id="mca-style-${p}" style="font-size:12px;color:var(--text-muted);margin:-2px 0 8px 8px;"></div>`;
 }).join('');
 } catch (e) { box.innerHTML = `<div style="color:var(--danger);font-size:12px;">${this._escapeHtml(String(e))}</div>`; }
 },

 async uploadCapture() {
 const input = document.getElementById('mca-capfile');
 if (!input || !input.files || !input.files[0]) return;
 const fd = new FormData();
 fd.append('file', input.files[0]);
 const r = await Auth.apiCall('/api/mc-agent/captures', { method: 'POST', body: fd });
 if (r.ok) { input.value = ''; Toast.success(Lang.t('mcagent.capture_import')); this.loadCaptures(); }
 else { const e = await r.json().catch(() => ({})); Toast.error(e.detail || 'Upload KO'); }
 },

 async distillCapture(player) {
 const r = await Auth.apiCall(`/api/mc-agent/captures/${encodeURIComponent(player)}/distill`, { method: 'POST' });
 const data = await r.json().catch(() => ({}));
 const el = document.getElementById('mca-style-' + player);
 if (r.ok && el) {
 const dp = (data.style && data.style.derivedParams) || {};
 const chat = dp.chat || {};
 el.innerHTML = `${Lang.t('mcagent.capture_stats')} — latence chat ${this._escapeHtml(chat.latencyMeanMs)}±${this._escapeHtml(chat.latencyStdMs)}ms · ` +
 `fautes ${this._escapeHtml(chat.typoRate)} · jitter ${this._escapeHtml(dp.movementJitter)} · ${this._escapeHtml(data.clips)} clips`;
 }
 },

 async deleteCapture(player) {
 if (!confirm(player + ' ?')) return;
 const r = await Auth.apiCall(`/api/mc-agent/captures/${encodeURIComponent(player)}`, { method: 'DELETE' });
 if (r.ok) this.loadCaptures();
 },

 async _loadScannerUsage() {
 try {
 const r = await Auth.apiCall('/api/bots/scanner/usage');
 if (r && r.ok) this._scannerState.usage = await r.json();
 } catch (e) {
 this._scannerState.usage = { today_scans: 0, max_scans: 2, remaining: 2 };
 }
 },

 _renderScannerConfig() {
 const container = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!container) return;

 const usage = this._scannerState.usage || { today_scans: 0, max_scans: 2, remaining: 2 };
 const usageClass = usage.remaining === 0 ? 'danger' : usage.remaining <= 1 ? 'warning' : '';
 const s = this._scannerState;

 container.innerHTML = `
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">SCN</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('scanner.title')}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('scanner.subtitle')}</p></div></div><div style="display:flex;gap:8px;align-items:center;"><span class="yield-usage-badge ${usageClass}">
 ${Lang.t('scanner.usage')}: ${usage.today_scans}/${usage.max_scans}
 </span><button class="btn btn-secondary btn-sm" onclick="BotsModule.render(BotsModule._container)">
 ${Lang.t('scanner.back_bots')}
 </button></div></div><div class="card" style="margin-bottom:20px;"><h3 style="margin:0 0 16px;">${Lang.t('scanner.config_title')}</h3><p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">${Lang.t('scanner.criteria_desc')}</p><!-- Prezzo massimo --><div class="yield-threshold-container" style="margin-bottom:14px;padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><label style="font-size:13px;font-weight:600;"> ${Lang.t('scanner.max_price')}</label><span id="scanner-price-value" style="font-size:14px;font-weight:700;color:var(--accent);">${s.maxPrice}</span></div><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;color:var(--text-muted);">85</span><input type="range" id="scanner-price-slider" min="85" max="110" step="0.5" value="${s.maxPrice}"
 style="flex:1;accent-color:var(--accent);cursor:pointer;"
 oninput="BotsModule._scannerState.maxPrice=parseFloat(this.value);document.getElementById('scanner-price-value').textContent=this.value"><span style="font-size:11px;color:var(--text-muted);">110</span></div></div><!-- Yield minimo --><div class="yield-threshold-container" style="margin-bottom:14px;padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><label style="font-size:13px;font-weight:600;">${Lang.t('scanner.min_yield')}</label><span id="scanner-yield-value" style="font-size:14px;font-weight:700;color:var(--accent);">${s.minYield}%</span></div><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;color:var(--text-muted);">1%</span><input type="range" id="scanner-yield-slider" min="1" max="10" step="0.5" value="${s.minYield}"
 style="flex:1;accent-color:var(--accent);cursor:pointer;"
 oninput="BotsModule._scannerState.minYield=parseFloat(this.value);document.getElementById('scanner-yield-value').textContent=this.value+'%'"><span style="font-size:11px;color:var(--text-muted);">10%</span></div></div><!-- Task 15 — Target count (renamed from "max results") --><div class="yield-threshold-container" style="margin-bottom:14px;padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><label style="font-size:13px;font-weight:600;"> ${Lang.t('scanner.target_count')}</label><span id="scanner-targetcount-value" style="font-size:14px;font-weight:700;color:var(--accent);">${s.targetCount}</span></div><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;color:var(--text-muted);">1</span><input type="range" id="scanner-targetcount-slider" min="1" max="100" step="1" value="${s.targetCount}"
 style="flex:1;accent-color:var(--accent);cursor:pointer;"
 oninput="BotsModule._scannerState.targetCount=parseInt(this.value);document.getElementById('scanner-targetcount-value').textContent=this.value"><span style="font-size:11px;color:var(--text-muted);">100</span></div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${Lang.t('scanner.target_count_hint')}</div></div><!-- Scadenza + Rating + Valute --><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;"><div style="padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);"><label style="font-size:13px;font-weight:600;">${Lang.t('scanner.maturity')}</label><select id="scanner-maturity" class="form-input" style="margin-top:8px;"
 onchange="BotsModule._scannerState.maxMaturity=parseInt(this.value)"><option value="5" ${s.maxMaturity===5?'selected':''}>5 anni</option><option value="7" ${s.maxMaturity===7?'selected':''}>7 anni</option><option value="9" ${s.maxMaturity===9?'selected':''}>9 anni</option><option value="12" ${s.maxMaturity===12?'selected':''}>12 anni</option><option value="15" ${s.maxMaturity===15?'selected':''}>15 anni</option></select></div><div style="padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);"><label style="font-size:13px;font-weight:600;">⭐ ${Lang.t('scanner.rating')}</label><select id="scanner-rating" class="form-input" style="margin-top:8px;"
 onchange="BotsModule._scannerState.minRating=this.value"><option value="BBB-" ${s.minRating==='BBB-'?'selected':''}>BBB- (IG floor)</option><option value="BBB" ${s.minRating==='BBB'?'selected':''}>BBB</option><option value="BBB+" ${s.minRating==='BBB+'?'selected':''}>BBB+</option><option value="A-" ${s.minRating==='A-'?'selected':''}>A-</option><option value="A" ${s.minRating==='A'?'selected':''}>A</option><option value="A+" ${s.minRating==='A+'?'selected':''}>A+</option><option value="AA-" ${s.minRating==='AA-'?'selected':''}>AA-</option><option value="AA" ${s.minRating==='AA'?'selected':''}>AA</option><option value="AA+" ${s.minRating==='AA+'?'selected':''}>AA+</option><option value="AAA" ${s.minRating==='AAA'?'selected':''}>AAA</option></select></div></div><!-- Valute --><div style="padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);margin-bottom:20px;"><label style="font-size:13px;font-weight:600;margin-bottom:8px;display:block;"> ${Lang.t('scanner.currencies')}</label><div style="display:flex;gap:12px;"><label style="font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="scanner-eur" ${s.currencies.EUR?'checked':''}
 onchange="BotsModule._scannerState.currencies.EUR=this.checked"> EUR
 </label><label style="font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="scanner-usd" ${s.currencies.USD?'checked':''}
 onchange="BotsModule._scannerState.currencies.USD=this.checked"> USD
 </label><label style="font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="scanner-gbp" ${s.currencies.GBP?'checked':''}
 onchange="BotsModule._scannerState.currencies.GBP=this.checked"> GBP
 </label></div></div><!-- Bouton admin : oublier les bonds REJETÉS (seen only ; found préservé) --><div id="scanner-reset-seen" data-admin-only="true" style="padding:12px 16px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);margin-bottom:20px;display:none;"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;"><div style="font-size:12px;color:var(--text-muted);line-height:1.45;">Réévalue au prochain scan les bonds précédemment écartés (rating/yield/∅). Auto-reset 60j de toute façon.</div><button class="btn btn-secondary btn-sm" style="white-space:nowrap;" onclick="BotsModule._scannerResetSeen()">Oublier les rejetés</button></div></div><!-- Launch button --><button id="scanner-launch-btn" class="yield-launch-btn" style="background:var(--accent);"
 onclick="BotsModule._launchScanner()" ${usage.remaining===0?'disabled':''}>
 ${usage.remaining === 0 ? Lang.t('scanner.rate_limit') : Lang.t('scanner.launch')}
 </button><div id="scanner-error-msg" style="display:none;margin-top:12px;color:var(--danger);font-size:13px;text-align:center;"></div></div>
 `;

 // Task 16 (2026-05-28) — Show admin Brave key section if user is admin,
 // then load its status. Same pattern que le Yield Bot : utilise Auth.getUser()
 // (PAS App.user — qui n'existe pas dans ce contexte, bug trouvé en test 28/05 18:53).
 const adminUser = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
 const isAdmin = adminUser && adminUser.is_admin;
 if (isAdmin) {
   const adminBlock = document.getElementById('scanner-reset-seen');
   if (adminBlock) adminBlock.style.display = 'block';
 }
 },

 // ================================================================
 //  Task 16 — Brave Search API key management (admin only)
 //  Shares data/secrets/brave.key with the Yield Bot.
 // ================================================================

 async _scannerLoadKeyStatus() {
   const statusEl = document.getElementById('scanner-rating-key-status');
   const actionsEl = document.getElementById('scanner-rating-key-actions');
   if (!statusEl || !actionsEl) return;
   try {
     const resp = await Auth.apiCall('/api/bots/scanner/settings/rating-key');
     if (!resp.ok) throw new Error('HTTP ' + resp.status);
     const data = await resp.json();
     if (data.has_key) {
       const srcLabel = data.source === 'env_var' ? 'env var' : 'file';
       statusEl.innerHTML = '<span style="color:var(--accent);">✓</span> <strong style="color:var(--text);">' + data.preview + '</strong> <span style="color:var(--text-dim);">· ' + srcLabel + ' · shared w/ Yield Bot</span>';
       actionsEl.innerHTML = data.source === 'file'
         ? '<button class="btn btn-secondary btn-sm" onclick="BotsModule._scannerShowKeyEdit()">' + Lang.t('scanner.config_key_set_btn') + '</button>'
           + '<button class="btn btn-danger btn-sm" onclick="BotsModule._scannerDeleteKey()">' + Lang.t('scanner.config_key_delete_btn') + '</button>'
         : '<span style="font-size:11px;color:var(--text-dim);">env var (SSH only)</span>';
     } else {
       statusEl.innerHTML = '<span style="color:var(--warning);">∅</span> <span style="color:var(--text-muted);">' + Lang.t('scanner.config_key_status_unset') + '</span>';
       actionsEl.innerHTML = '<button class="btn btn-primary btn-sm" onclick="BotsModule._scannerShowKeyEdit()">' + Lang.t('scanner.config_key_set_btn') + '</button>';
     }
   } catch (e) {
     statusEl.innerHTML = '<span style="color:var(--danger);">✗</span> <span style="color:var(--text-muted);">load error: ' + e.message + '</span>';
     actionsEl.innerHTML = '';
   }
 },

 _scannerShowKeyEdit() {
   const form = document.getElementById('scanner-rating-key-form');
   const actions = document.getElementById('scanner-rating-key-actions');
   if (form) form.style.display = 'block';
   if (actions) actions.style.display = 'none';
   const input = document.getElementById('scanner-rating-key-input');
   if (input) { input.value = ''; input.focus(); }
 },

 _scannerCancelKeyEdit() {
   const form = document.getElementById('scanner-rating-key-form');
   const actions = document.getElementById('scanner-rating-key-actions');
   if (form) form.style.display = 'none';
   if (actions) actions.style.display = 'flex';
 },

 async _scannerSaveKey() {
   const input = document.getElementById('scanner-rating-key-input');
   const key = (input && input.value || '').trim();
   if (!key) { (typeof Toast !== 'undefined' && Toast.warning) ? Toast.warning('Clé vide') : alert('Clé vide'); return; }
   try {
     const resp = await Auth.apiCall('/api/bots/scanner/settings/rating-key', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ key }),
     });
     const data = await resp.json();
     if (!resp.ok) { (typeof Toast !== 'undefined' && Toast.error) ? Toast.error(data.detail || 'HTTP ' + resp.status) : alert(data.detail); return; }
     (typeof Toast !== 'undefined' && Toast.success) ? Toast.success(data.message || 'Clé enregistrée') : null;
     this._scannerCancelKeyEdit();
     this._scannerLoadKeyStatus();
   } catch (e) {
     (typeof Toast !== 'undefined' && Toast.error) ? Toast.error('save error: ' + e.message) : alert('save error: ' + e.message);
   }
 },

 async _scannerDeleteKey() {
   const ok = confirm('Supprimer la clé Brave ? Le rating fetcher des 2 bots sera désactivé.');
   if (!ok) return;
   try {
     const resp = await Auth.apiCall('/api/bots/scanner/settings/rating-key', { method: 'DELETE' });
     const data = await resp.json();
     if (!resp.ok) { (typeof Toast !== 'undefined' && Toast.error) ? Toast.error(data.detail || 'HTTP ' + resp.status) : alert(data.detail); return; }
     (typeof Toast !== 'undefined' && Toast.success) ? Toast.success(data.message || 'Clé supprimée') : null;
     this._scannerLoadKeyStatus();
   } catch (e) {
     (typeof Toast !== 'undefined' && Toast.error) ? Toast.error('delete error: ' + e.message) : alert('delete error: ' + e.message);
   }
 },

 async _scannerResetSeen() {
   const ok = confirm('Oublier les bonds rejetés ? Ils reconcourront au prochain scan (sinon auto-reset 60j).');
   if (!ok) return;
   try {
     const resp = await Auth.apiCall('/api/bots/scanner/reset-seen', { method: 'POST' });
     const data = await resp.json();
     if (!resp.ok) { (typeof Toast !== 'undefined' && Toast.error) ? Toast.error(data.detail || ('HTTP ' + resp.status)) : alert(data.detail); return; }
     (typeof Toast !== 'undefined' && Toast.success) ? Toast.success(data.message || 'Rejetés oubliés') : null;
   } catch (e) {
     (typeof Toast !== 'undefined' && Toast.error) ? Toast.error('reset error: ' + e.message) : alert('reset error: ' + e.message);
   }
 },

 async _launchScanner() {
 const btn = document.getElementById('scanner-launch-btn');
 if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
 const errMsg = document.getElementById('scanner-error-msg');
 if (errMsg) errMsg.style.display = 'none';

 const s = this._scannerState;
 const currencies = Object.entries(s.currencies).filter(([,v]) => v).map(([k]) => k).join(',');
 if (!currencies) {
 if (errMsg) { errMsg.style.display = 'block'; errMsg.textContent = 'Seleziona almeno una valuta'; }
 if (btn) { btn.disabled = false; btn.textContent = Lang.t('scanner.launch'); }
 return;
 }

 try {
 const r = await Auth.apiCall('/api/bots/scanner/run', {
 method: 'POST',
 body: JSON.stringify({
 max_price: s.maxPrice,
 min_yield: s.minYield / 100,
 max_maturity: s.maxMaturity,
 min_rating: s.minRating,
 currencies: currencies,
 price_threshold: s.priceThreshold,
 target_count: s.targetCount,  // Task 15 (2026-05-28) — was max_results
 }),
 });
 if (!r || !r.ok) {
 const err = r ? await r.json().catch(() => ({})) : {};
 throw new Error(err.detail || 'Launch failed');
 }
 const data = await r.json();
 this._scannerState.jobId = data.job_id;
 this._scannerState.status = 'running';
 this._renderScannerRunning();
 } catch (e) {
 if (btn) { btn.disabled = false; btn.textContent = Lang.t('scanner.launch'); }
 if (errMsg) { errMsg.style.display = 'block'; errMsg.textContent = `${e.message}`; }
 }
 },

 _renderScannerRunning() {
 const container = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!container) return;

 container.innerHTML = `
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">SCN</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('scanner.title')} — <span class="yield-pulse"></span>${Lang.t('scanner.running')}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('scanner.subtitle')}</p></div></div></div><div class="card" style="margin-bottom:16px;"><div class="yield-progress-container"><div class="yield-progress-bar"><div id="scanner-progress-fill" class="yield-progress-fill" style="width:0%;background:var(--accent);"></div></div><div class="yield-progress-text"><span id="scanner-progress-label">${Lang.t('scanner.running')}</span><span id="scanner-progress-percent" class="yield-progress-percent">0%</span></div></div><div class="yield-stats"><div class="yield-stat-card" style="border-left:3px solid var(--info);"><div id="scanner-stat-scanned" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('scanner.scanned')}</div></div><div class="yield-stat-card success"><div id="scanner-stat-found" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('scanner.found')}</div></div><div class="yield-stat-card warning"><div id="scanner-stat-discarded" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('scanner.discarded')}</div></div><div class="yield-stat-card error"><div id="scanner-stat-errors" class="yield-stat-value">0</div><div class="yield-stat-label">${Lang.t('scanner.errors')}</div></div></div></div><div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">Log</h3><button class="btn btn-danger btn-sm" onclick="BotsModule._stopScanner()">${Lang.t('scanner.stop')}</button></div><div id="scanner-logs" class="yield-terminal"><div style="color:#6b7280;text-align:center;padding:20px;">⏳ ${Lang.t('scanner.running')}</div></div></div>
 `;

 this._startScannerPolling();
 },

 _startScannerPolling() {
 if (this._scannerState.pollInterval) clearInterval(this._scannerState.pollInterval);
 this._pollScannerStatus();
 this._scannerState.pollInterval = setInterval(() => this._pollScannerStatus(), 2000);
 },

 async _pollScannerStatus() {
 const jobId = this._scannerState.jobId;
 if (!jobId) return;

 try {
 const r = await Auth.apiCall(`/api/bots/scanner/status/${jobId}`);
 if (!r || !r.ok) return;
 const data = await r.json();

 const fill = document.getElementById('scanner-progress-fill');
 const pct = document.getElementById('scanner-progress-percent');
 const label = document.getElementById('scanner-progress-label');
 if (fill) fill.style.width = `${data.progress_percent}%`;
 if (pct) pct.textContent = `${data.progress_percent}%`;

 const cc = data.completed_currencies || [];
 if (label && cc.length > 0) label.textContent = cc.join(', ');

 const ss = data.stats || {};
 const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v || 0; };
 el('scanner-stat-scanned', ss.total_scanned);
 el('scanner-stat-found', ss.total_filtered);
 el('scanner-stat-discarded', ss.total_discarded);
 el('scanner-stat-errors', ss.total_errors);

 const logsEl = document.getElementById('scanner-logs');
 if (logsEl && data.logs && data.logs.length > 0) {
 logsEl.innerHTML = data.logs.map((l, i) => `
 <div class="yield-log-line"><span class="yield-log-num">${i + 1}</span><span class="yield-log-content">${l.replace(/</g, '&lt;')}</span></div>
 `).join('');
 logsEl.scrollTop = logsEl.scrollHeight;
 }

 if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
 this._scannerState.status = data.status;
 clearInterval(this._scannerState.pollInterval);
 this._scannerState.pollInterval = null;
 setTimeout(() => this._renderScannerCompleted(data), 1000);
 }
 } catch (e) { console.error('[Scanner] Poll error:', e); }
 },

 _renderScannerCompleted(data) {
 const container = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!container) return;

 const isSuccess = data.status === 'completed';
 const statusIcon = isSuccess ? 'OK' : data.status === 'error' ? 'ERR' : 'STOP';
 const statusLabel = isSuccess ? Lang.t('scanner.completed') : data.status === 'error' ? Lang.t('scanner.error') : Lang.t('scanner.stopped');
 const ss = data.stats || {};

 container.innerHTML = `
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">SCN</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('scanner.title')} — ${statusIcon} ${statusLabel}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('scanner.subtitle')}</p></div></div></div><div class="card" style="margin-bottom:16px;"><h3 style="margin:0 0 16px;">${Lang.t('scanner.summary')}</h3><div class="yield-stats"><div class="yield-stat-card" style="border-left:3px solid var(--info);"><div class="yield-stat-value">${ss.total_scanned || 0}</div><div class="yield-stat-label">${Lang.t('scanner.scanned')}</div></div><div class="yield-stat-card success"><div class="yield-stat-value">${ss.total_filtered || 0}</div><div class="yield-stat-label">${Lang.t('scanner.found')}</div></div><div class="yield-stat-card warning"><div class="yield-stat-value">${ss.total_discarded || 0}</div><div class="yield-stat-label">${Lang.t('scanner.discarded')}</div></div><div class="yield-stat-card error"><div class="yield-stat-value">${ss.total_errors || 0}</div><div class="yield-stat-label">${Lang.t('scanner.errors')}</div></div></div><div style="display:flex;gap:12px;margin-top:20px;">
 ${isSuccess && data.result_file ? `
 <button class="yield-launch-btn" style="flex:1;margin-top:0;background:var(--accent);" onclick="BotsModule._downloadScannerResult()">
 ${Lang.t('scanner.download')}
 </button>
 ` : ''}
 <button class="btn btn-secondary" style="flex:1;padding:14px;font-size:15px;font-weight:600;" onclick="BotsModule._startNewScan()">
 ${Lang.t('scanner.restart')}
 </button></div></div><div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;">Log (${data.logs_count || data.logs?.length || 0} ${Lang.t('bots.lines')})</h3></div><div class="yield-terminal">
 ${data.logs && data.logs.length > 0
 ? data.logs.map((l, i) => `
 <div class="yield-log-line"><span class="yield-log-num">${i + 1}</span><span class="yield-log-content">${l.replace(/</g, '&lt;')}</span></div>
 `).join('')
 : '<div style="color:#6b7280;text-align:center;padding:20px;">No logs</div>'
 }
 </div></div>
 `;
 },

 async _downloadScannerResult() {
 const jobId = this._scannerState.jobId;
 if (!jobId) return;
 const token = Auth.getToken();
 if (!token) return;
 const today = new Date().toISOString().slice(0, 10);
 const filename = `Opportunita_Bond_${today}.xlsx`;

 try {
 // Méthode 1: fetch + blob (contrôle du nom de fichier)
 const r = await fetch(`/api/bots/scanner/download/${jobId}`, {
 headers: { 'Authorization': `Bearer ${token}` }
 });
 if (!r.ok) throw new Error('Download failed: ' + r.status);

 const blob = await r.blob();

 // Vérifier que c'est bien un fichier Excel (pas du HTML/JSON d'erreur)
 if (blob.size < 1000 || blob.type.includes('text') || blob.type.includes('json')) {
 throw new Error('Response is not a valid Excel file');
 }

 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = filename;
 a.style.display = 'none';
 document.body.appendChild(a);
 a.click();
 setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
 } catch (e) {
 console.error('[Scanner] Download blob error:', e);
 // Fallback: window.open avec le nom dans l'URL (contourne Cloudflare)
 window.open(
 `/api/bots/scanner/download-file/${jobId}/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`,
 '_blank'
 );
 }
 },

 async _stopScanner() {
 const jobId = this._scannerState.jobId;
 if (!jobId) return;
 try { await Auth.apiCall(`/api/bots/scanner/stop/${jobId}`, { method: 'POST' }); }
 catch (e) { console.error('[Scanner] Stop error:', e); }
 },

 async _startNewScan() {
 this._scannerState.jobId = null;
 this._scannerState.status = null;
 if (this._scannerState.pollInterval) {
 clearInterval(this._scannerState.pollInterval);
 this._scannerState.pollInterval = null;
 }
 await this._loadScannerUsage();
 this._renderScannerConfig();
 },
};

