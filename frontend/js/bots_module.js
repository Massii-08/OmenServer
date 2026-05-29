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
 // Ne PAS arrêter le polling yield ici — le backend continue de tourner
 // On nettoie seulement l'interval, le jobId reste en mémoire pour reconnexion
 if (this._yieldState.pollInterval) {
 clearInterval(this._yieldState.pollInterval);
 this._yieldState.pollInterval = null;
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
 const canSeeMCAgent = u && u.is_admin;
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

 if (this._bots.length === 0) {
 grid.innerHTML = `
 ${u && u.role === 'developer' ? `<div class="b-quota-row"><span class="bot-quota-badge">${Lang.t('rbac.bot_quota')}: 0/3</span></div>` : ''}
 <div class="bots-grid-bento">
 ${yieldBotCard}
 ${scannerBotCard}
 ${mcAgentCard}
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
 <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"><h3 style="margin:0;">${Lang.t('bots.schedule')} — ${botName}</h3><button class="btn btn-secondary btn-sm" onclick="document.getElementById('bot-detail').style.display='none'"></button></div><!-- Formulaire nouvelle tâche --><div style="background:var(--bg-elev-3);border-radius:8px;padding:14px;margin-bottom:16px;border:1px solid var(--border);"><div style="font-size:13px;font-weight:600;margin-bottom:10px;">${Lang.t('bots.new_sched_task')}</div><div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;"><div style="flex:1;min-width:140px;"><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.type')}</label><select id="bot-sched-type" class="form-input" style="margin-top:4px;"><option value="bot_start">${Lang.t('scheduler.bot_start')}</option><option value="bot_stop">${Lang.t('scheduler.bot_stop')}</option><option value="bot_restart">${Lang.t('scheduler.bot_restart')}</option></select></div><div style="flex:1;min-width:110px;"><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.mode')}</label><select id="bot-sched-mode" class="form-input" style="margin-top:4px;" onchange="BotsModule._onBotSchedModeChange()"><option value="interval">${Lang.t('scheduler.mode_interval')}</option><option value="fixed">${Lang.t('scheduler.mode_fixed')}</option></select></div></div><!-- Mode intervalle --><div id="bot-sched-interval-row" style="display:flex;gap:8px;align-items:flex-end;margin-top:8px;"><div style="flex:1;min-width:100px;"><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.interval')}</label><select id="bot-sched-interval" class="form-input" style="margin-top:4px;"><option value="1">1h</option><option value="3">3h</option><option value="6" selected>6h</option><option value="12">12h</option><option value="24">24h</option><option value="48">48h</option><option value="168">${Lang.t('scheduler.week')}</option></select></div><button class="btn btn-primary" onclick="BotsModule.createBotTask(${botId})">${Lang.t('scheduler.add')}</button></div><!-- Mode heure fixe --><div id="bot-sched-fixed-row" style="display:none;margin-top:8px;"><div style="display:flex;gap:8px;align-items:flex-end;"><div><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.time')}</label><input type="time" id="bot-sched-time" class="form-input" style="margin-top:4px;" value="08:00" /></div><button class="btn btn-primary" onclick="BotsModule.createBotTask(${botId})">${Lang.t('scheduler.add')}</button></div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;"><label style="font-size:12px;color:var(--text-muted);margin-right:4px;">${Lang.t('scheduler.days')}:</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="bot-day-daily" checked onchange="BotsModule._onBotDailyToggle(this)"> ${Lang.t('scheduler.daily')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="mon" disabled> ${Lang.t('scheduler.day_mon')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="tue" disabled> ${Lang.t('scheduler.day_tue')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="wed" disabled> ${Lang.t('scheduler.day_wed')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="thu" disabled> ${Lang.t('scheduler.day_thu')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="fri" disabled> ${Lang.t('scheduler.day_fri')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="sat" disabled> ${Lang.t('scheduler.day_sat')}</label><label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="sun" disabled> ${Lang.t('scheduler.day_sun')}</label></div></div><div id="bot-sched-msg" style="font-size:12px;margin-top:8px;"></div></div><!-- Liste des tâches -->
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
     statusEl.innerHTML = `<span style="color:var(--danger);">✗</span> <span style="color:var(--text-muted);">${Lang.t('yield.config_load_error') || 'Erreur de chargement'} (${e.message})</span>`;
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
 <div class="yield-file-info"><span class="b-ticker">XLS</span><div class="yield-file-details"><div class="yield-file-name">${f.name}</div><div class="yield-file-meta">${sizeKB} KB</div></div><button class="yield-file-remove" onclick="event.stopPropagation();BotsModule._removeYieldFile()"></button></div>
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
 <div class="yield-header"><div class="yield-header-left"><span class="b-ticker">YLD</span><div><h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')} — ${statusIcon} ${statusLabel}</h1><p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${data.filename || ''}</p></div></div></div><!-- Stats résumé --><div class="card" style="margin-bottom:16px;"><h3 style="margin:0 0 16px;">${Lang.t('yield.summary')}</h3><div class="yield-stats"><div class="yield-stat-card success"><div class="yield-stat-value">${data.stats?.updated || 0}</div><div class="yield-stat-label">${Lang.t('yield.updated')}</div></div><div class="yield-stat-card warning"><div class="yield-stat-value">${data.stats?.skipped || 0}</div><div class="yield-stat-label">${Lang.t('yield.skipped')}</div></div><div class="yield-stat-card error"><div class="yield-stat-value">${data.stats?.errors || 0}</div><div class="yield-stat-label">${Lang.t('yield.errors')}</div></div></div><!-- Progress bar complète --><div class="yield-progress-container" style="margin-top:16px;"><div class="yield-progress-bar"><div class="yield-progress-fill" style="width:${data.progress_percent || 0}%;${!isSuccess ? 'background:var(--warning);' : ''}"></div></div><div class="yield-progress-text" style="margin-top:4px;"><span>${data.progress || ''}</span><span class="yield-progress-percent">${data.progress_percent || 0}%</span></div></div><!-- Actions --><div style="display:flex;gap:12px;margin-top:20px;">
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
 // Stoppe le poll scanner (évite le bleed) ET un éventuel poll MC Agent résiduel
 if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
 if (this._mcAgentTimer) { clearInterval(this._mcAgentTimer); this._mcAgentTimer = null; }
 this._mcAgentSession = this._mcAgentSession || null;
 // Conteneur canonique du module (cf. openBondScanner/_renderYield* : this._container set dans render())
 const el = this._container || document.getElementById('bots-module-container')?.parentElement;
 if (!el) return;
 el.innerHTML = `
 <div class="card">
 <h3 style="margin:0 0 12px;">MC Agent — ${Lang.t('mcagent.training')}</h3>
 <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:var(--bg-elev-3);border-radius:10px;border:1px solid var(--border);">
 <span style="font-size:13px;font-weight:600;">${Lang.t('mcagent.key_title')}</span>
 <span id="mca-key-status" style="font-size:12px;color:var(--text-muted);">…</span>
 <input id="mca-key" class="form-input" type="password" placeholder="${Lang.t('mcagent.key_placeholder')}" style="flex:1;min-width:160px;" />
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.saveMCAgentKey()">${Lang.t('mcagent.key_save')}</button>
 <button class="btn btn-ghost btn-sm" onclick="BotsModule.clearMCAgentKey()">${Lang.t('mcagent.key_clear')}</button>
 </div>
 <div style="display:grid;grid-template-columns:1fr 100px;gap:10px;margin-bottom:10px;">
 <div><label class="form-label">${Lang.t('mcagent.ip')}</label><input id="mca-host" class="form-input" placeholder="192.168.1.x ou play.exemple.net" /></div>
 <div><label class="form-label">${Lang.t('mcagent.port')}</label><input id="mca-port" class="form-input" value="25565" /></div>
 </div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
 <div><label class="form-label">${Lang.t('mcagent.account')}</label><input id="mca-user" class="form-input" value="TrainBot" placeholder="pseudo ou email" /></div>
 <div><label class="form-label">${Lang.t('mcagent.auth_label')}</label><select id="mca-auth" class="form-input"><option value="offline">${Lang.t('mcagent.auth_offline')}</option><option value="microsoft">${Lang.t('mcagent.auth_microsoft')}</option></select></div>
 <div><label class="form-label">${Lang.t('mcagent.profile')}</label><select id="mca-profile" class="form-input" onchange="BotsModule.renderMCAgentTells()"></select></div>
 </div>
 <div style="font-size:11px;color:var(--text-muted);margin:-4px 0 12px;">${Lang.t('mcagent.ms_hint')}</div>
 <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
 <button class="btn btn-primary" onclick="BotsModule.startMCAgent()">${Lang.t('mcagent.start')}</button>
 <button class="btn btn-secondary btn-sm" onclick="BotsModule.stopMCAgent()">${Lang.t('mcagent.stop')}</button>
 <span id="mca-msg" style="font-size:13px;color:var(--text-muted);"></span>
 </div>
 <div id="mca-tells" style="display:none;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--text-muted);"></div>
 <div id="mca-transcript" style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;"></div>
 <div style="display:flex;gap:8px;margin-top:10px;">
 <input id="mca-say" class="form-input" placeholder="${Lang.t('mcagent.say_placeholder')}" style="flex:1;" />
 <button class="btn btn-secondary" onclick="BotsModule.sayMCAgent()">${Lang.t('mcagent.send')}</button>
 </div>
 </div>`;
 this._loadMCAgentKey();
 this.loadMCAgentProfiles();
 },

 async startMCAgent() {
 const host = document.getElementById('mca-host').value.trim();
 const port = parseInt(document.getElementById('mca-port').value, 10) || 25565;
 const user = document.getElementById('mca-user').value.trim() || 'TrainBot';
 const auth = document.getElementById('mca-auth').value;
 const profile = (document.getElementById('mca-profile') || {}).value || undefined;
 const msg = document.getElementById('mca-msg');
 if (!host) { msg.textContent = Lang.t('mcagent.need_host'); return; }
 const r = await Auth.apiCall('/api/mc-agent/run', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ host, port, user, auth, profile }),
 });
 if (!r) return;
 const data = await r.json().catch(() => ({}));
 if (!r.ok) { msg.textContent = data.detail || 'Erreur'; return; }
 this._mcAgentSession = data.session_id;
 msg.textContent = `session #${data.session_id}`;
 this._mcAgentTimer = setInterval(() => BotsModule.refreshMCAgent(), 3000);
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
 `<option value="${esc(p.id)}">${esc(p.label)} (niv. ${esc(p.level)})</option>`
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
 `<div style="font-weight:600;color:var(--text);margin-bottom:6px;">${esc(Lang.t('mcagent.tells_title'))} — ${esc(prof.label)}</div>` +
 `<ul style="margin:0;padding-left:18px;">` +
 prof.tells.map((t) => `<li style="margin:2px 0;">${esc(t)}</li>`).join('') +
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

