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
            <div id="bots-module-container">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                    <div>
                        <h1 style="margin:0;">${Lang.t('bots.title')}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">${Lang.t('bots.subtitle')}</p>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        ${(() => {
                            const u = Auth.getUser();
                            const canCreate = u && (u.is_admin || u.role === 'developer');
                            if (!canCreate) return '';
                            return `<button class="btn btn-primary" onclick="BotsModule.showCreateForm()">➕ ${Lang.t('bots.new')}</button>`;
                        })()}
                        <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Hub</button>
                    </div>
                </div>

                <div id="bot-create-form" style="display:none;margin-bottom:20px;"></div>
                <div id="bots-grid"><div style="text-align:center;padding:20px;color:var(--text-muted);">${Lang.t('bots.loading')}</div></div>
                <div id="bot-detail" style="display:none;margin-top:20px;"></div>
            </div>
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

        const typeIcons = { trading: '📈', gaming: '🎮', scraper: '🕷️', analysis: '📊', custom: '🐍' };
        const statusColors = { running: '#22c55e', stopped: '#6b7280', error: '#ef4444' };
        const statusLabels = { running: Lang.t('bots.running'), stopped: Lang.t('bots.stopped'), error: Lang.t('bots.error') };

        // Carte virtuelle du Yield Bot (visible seulement pour admin et money)
        const u = Auth.getUser();
        const canSeeYield = u && (u.is_admin || u.role === 'money' || u.role === 'admin');
        const yieldBotCard = canSeeYield ? `
            <div class="card" style="cursor:pointer;transition:all .15s;border:2px solid transparent;background:linear-gradient(135deg, var(--bg-card) 0%, rgba(59,130,246,0.06) 100%);"
                onclick="BotsModule.openYieldBot()"
                onmouseover="this.style.transform='translateY(-2px)';this.style.borderColor='var(--accent-blue)'"
                onmouseout="this.style.transform='';this.style.borderColor='transparent'">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="font-size:24px;">🏦</span>
                        <div>
                            <div style="font-weight:700;font-size:14px;">Yield Calculator</div>
                            <div style="font-size:11px;color:var(--text-muted);">analysis</div>
                        </div>
                    </div>
                    <span style="font-size:11px;padding:2px 8px;border-radius:4px;color:var(--accent-blue);background:rgba(59,130,246,0.12);font-weight:600;">⚡ ${Lang.t('modules.active')}</span>
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${Lang.t('yield.subtitle')}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <span class="btn btn-sm" style="font-size:11px;padding:4px 12px;background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;cursor:pointer;">▶ ${Lang.t('yield.launch')}</span>
                </div>
            </div>
        ` : '';

        // Carte virtuelle du Bond Scanner (visible seulement pour admin et money)
        const canSeeScanner = u && (u.is_admin || u.role === 'money' || u.role === 'admin');
        const scannerBotCard = canSeeScanner ? `
            <div class="card" style="cursor:pointer;transition:all .15s;border:2px solid transparent;background:linear-gradient(135deg, var(--bg-card) 0%, rgba(16,185,129,0.06) 100%);"
                onclick="BotsModule.openBondScanner()"
                onmouseover="this.style.transform='translateY(-2px)';this.style.borderColor='#10b981'"
                onmouseout="this.style.transform='';this.style.borderColor='transparent'">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span style="font-size:24px;">🔍</span>
                        <div>
                            <div style="font-weight:700;font-size:14px;">Bond Scanner</div>
                            <div style="font-size:11px;color:var(--text-muted);">analysis</div>
                        </div>
                    </div>
                    <span style="font-size:11px;padding:2px 8px;border-radius:4px;color:#10b981;background:rgba(16,185,129,0.12);font-weight:600;">⚡ ${Lang.t('modules.active')}</span>
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${Lang.t('scanner.subtitle')}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <span class="btn btn-sm" style="font-size:11px;padding:4px 12px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;cursor:pointer;">▶ ${Lang.t('scanner.launch')}</span>
                </div>
            </div>
        ` : '';

        if (this._bots.length === 0) {
            grid.innerHTML = `
                ${u && u.role === 'developer' ? `<div style="margin-bottom:12px;"><span class="bot-quota-badge">${Lang.t('rbac.bot_quota')}: 0/3</span></div>` : ''}
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
                    ${yieldBotCard}
                    ${scannerBotCard}
                </div>`;
            return;
        }

        // Quota pour les devs
        const quotaHtml = u && u.role === 'developer' ? (() => {
            const ownBots = this._bots.filter(b => b.owner_id === u.id).length;
            const isFull = ownBots >= 3;
            return `<div style="margin-bottom:12px;"><span class="bot-quota-badge ${isFull ? 'full' : ''}">${isFull ? '🚫' : '🤖'} ${Lang.t('rbac.bot_quota')}: ${ownBots}/3</span></div>`;
        })() : '';

        grid.innerHTML = `
            ${quotaHtml}
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
                ${yieldBotCard}
                ${scannerBotCard}
                ${this._bots.map(b => {
                    const isOwner = u && (u.is_admin || b.owner_id === u.id);
                    const canManage = isOwner || u?.is_admin;
                    return `
                    <div class="card" style="cursor:pointer;transition:all .15s;border:2px solid ${this._selectedBot?.id === b.id ? 'var(--accent-blue)' : 'transparent'};"
                        onclick="BotsModule.selectBot(${b.id})"
                        onmouseover="this.style.transform='translateY(-2px)'"
                        onmouseout="this.style.transform=''">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:24px;">${typeIcons[b.bot_type] || '🐍'}</span>
                                <div>
                                    <div style="font-weight:700;font-size:14px;">${b.name}</div>
                                    <div style="font-size:11px;color:var(--text-muted);">${b.bot_type}${!isOwner ? ' · <span style="color:var(--accent-blue);">' + Lang.t('sharing.shared_with_you') + '</span>' : ''}</div>
                                </div>
                            </div>
                            <span style="font-size:11px;padding:2px 8px;border-radius:4px;color:${statusColors[b.status]};background:${statusColors[b.status]}15;font-weight:600;">
                                ${statusLabels[b.status] || b.status}
                            </span>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${b.description || Lang.t('bots.no_desc')}</div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;">
                            ${b.status === 'running' 
                                ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();BotsModule.stopBot(${b.id})" style="font-size:11px;padding:4px 12px;">⏹ Stop</button>`
                                : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();BotsModule.startBot(${b.id})" style="font-size:11px;padding:4px 12px;">▶ Start</button>`
                            }
                            ${canManage ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();BotsModule.openEditor(${b.id})" style="font-size:11px;padding:4px 12px;">✏️ Code</button>` : ''}
                            ${canManage ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();BotsModule.showScheduler(${b.id})" style="font-size:11px;padding:4px 12px;">⏰ ${Lang.t('bots.schedule')}</button>` : ''}
                            ${isOwner ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();SharingModal.open(${b.id},'bot')" style="font-size:11px;padding:4px 8px;" title="${Lang.t('sharing.title')}">👥</button>` : ''}
                            ${isOwner ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();BotsModule.deleteBot(${b.id})" style="font-size:11px;padding:4px 8px;color:#ef4444;">🗑</button>` : ''}
                        </div>
                    </div>
                `;}).join('')}
            </div>`;
    },

    showCreateForm() {
        const form = document.getElementById('bot-create-form');
        if (!form) return;
        form.style.display = 'block';
        form.innerHTML = `
            <div class="card">
                <h3 style="margin:0 0 16px;">➕ ${Lang.t('bots.create')}</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                    <div>
                        <label class="form-label">${Lang.t('bots.name')}</label>
                        <input id="bot-name" class="form-input" placeholder="Mon bot trading" />
                    </div>
                    <div>
                        <label class="form-label">Type</label>
                        <select id="bot-type" class="form-input">
                            <option value="custom">🐍 Custom</option>
                            <option value="trading">📈 Trading</option>
                            <option value="gaming">🎮 Gaming</option>
                            <option value="scraper">🕷️ Scraper</option>
                            <option value="analysis">📊 ${Lang.t('bots.analysis')}</option>
                        </select>
                    </div>
                    <div>
                        <label class="form-label">Description</label>
                        <input id="bot-desc" class="form-input" placeholder="Ce bot fait..." />
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-primary" onclick="BotsModule.createBot()">${Lang.t('common.save')}</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('bot-create-form').style.display='none'">${Lang.t('common.cancel')}</button>
                    <span id="bot-create-msg" style="font-size:13px;"></span>
                </div>
            </div>`;
    },

    async createBot() {
        const name = document.getElementById('bot-name')?.value?.trim();
        const type = document.getElementById('bot-type')?.value || 'custom';
        const desc = document.getElementById('bot-desc')?.value?.trim() || '';
        const msg = document.getElementById('bot-create-msg');

        if (!name) { if (msg) { msg.style.color = '#ef4444'; msg.textContent = Lang.t('bots.name_required'); } return; }

        const r = await Auth.apiCall('/api/bots', {
            method: 'POST',
            body: JSON.stringify({ name, bot_type: type, description: desc })
        });

        if (r && r.ok) {
            document.getElementById('bot-create-form').style.display = 'none';
            await this.loadBots();
        } else {
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${Lang.t('common.error')}`; }
        }
    },

    async startBot(id) {
        const r = await Auth.apiCall(`/api/bots/${id}/start`, { method: 'POST' });
        if (r && r.ok) {
            await this.loadBots();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
            else alert(`❌ ${err.detail || Lang.t('common.error')}`);
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
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 ${Lang.t('bots.logs')} — ${bot?.name || 'Bot'}</h3>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span style="font-size:11px;color:var(--text-muted);">${logs.logs.length} ${Lang.t('bots.lines')}</span>
                        <button class="btn btn-secondary btn-sm" onclick="BotsModule.showBotDetail(${id})">🔄 ${Lang.t('common.refresh')}</button>
                    </div>
                </div>
                <div id="bot-logs-terminal" style="background:#0d1117;border-radius:8px;padding:12px;max-height:350px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;">
                    ${logs.logs.length > 0 
                        ? logs.logs.map((l, i) => `<div style="display:flex;gap:8px;"><span style="color:#6b7280;min-width:28px;text-align:right;user-select:none;">${i+1}</span><span>${l.replace(/</g,'&lt;')}</span></div>`).join('')
                        : `<div style="color:#6b7280;text-align:center;padding:20px;">${Lang.t('bots.no_logs')}</div>`
                    }
                </div>
            </div>`;
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
        const taskIcons = { bot_start: '▶️', bot_stop: '⏹️', bot_restart: '🔄' };

        detail.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <h3 style="margin:0;">⏰ ${Lang.t('bots.schedule')} — ${botName}</h3>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('bot-detail').style.display='none'">✕</button>
                </div>

                <!-- Formulaire nouvelle tâche -->
                <div style="background:var(--bg-primary);border-radius:8px;padding:14px;margin-bottom:16px;border:1px solid var(--border-color);">
                    <div style="font-size:13px;font-weight:600;margin-bottom:10px;">${Lang.t('bots.new_sched_task')}</div>
                    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
                        <div style="flex:1;min-width:140px;">
                            <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.type')}</label>
                            <select id="bot-sched-type" class="form-input" style="margin-top:4px;">
                                <option value="bot_start">${Lang.t('scheduler.bot_start')}</option>
                                <option value="bot_stop">${Lang.t('scheduler.bot_stop')}</option>
                                <option value="bot_restart">${Lang.t('scheduler.bot_restart')}</option>
                            </select>
                        </div>
                        <div style="flex:1;min-width:110px;">
                            <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.mode')}</label>
                            <select id="bot-sched-mode" class="form-input" style="margin-top:4px;" onchange="BotsModule._onBotSchedModeChange()">
                                <option value="interval">⏰ ${Lang.t('scheduler.mode_interval')}</option>
                                <option value="fixed">📅 ${Lang.t('scheduler.mode_fixed')}</option>
                            </select>
                        </div>
                    </div>
                    <!-- Mode intervalle -->
                    <div id="bot-sched-interval-row" style="display:flex;gap:8px;align-items:flex-end;margin-top:8px;">
                        <div style="flex:1;min-width:100px;">
                            <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.interval')}</label>
                            <select id="bot-sched-interval" class="form-input" style="margin-top:4px;">
                                <option value="1">1h</option><option value="3">3h</option><option value="6" selected>6h</option>
                                <option value="12">12h</option><option value="24">24h</option><option value="48">48h</option>
                                <option value="168">${Lang.t('scheduler.week')}</option>
                            </select>
                        </div>
                        <button class="btn btn-primary" onclick="BotsModule.createBotTask(${botId})">➕ ${Lang.t('scheduler.add')}</button>
                    </div>
                    <!-- Mode heure fixe -->
                    <div id="bot-sched-fixed-row" style="display:none;margin-top:8px;">
                        <div style="display:flex;gap:8px;align-items:flex-end;">
                            <div><label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.time')}</label><input type="time" id="bot-sched-time" class="form-input" style="margin-top:4px;" value="08:00" /></div>
                            <button class="btn btn-primary" onclick="BotsModule.createBotTask(${botId})">➕ ${Lang.t('scheduler.add')}</button>
                        </div>
                        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                            <label style="font-size:12px;color:var(--text-muted);margin-right:4px;">${Lang.t('scheduler.days')}:</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="bot-day-daily" checked onchange="BotsModule._onBotDailyToggle(this)"> ${Lang.t('scheduler.daily')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="mon" disabled> ${Lang.t('scheduler.day_mon')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="tue" disabled> ${Lang.t('scheduler.day_tue')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="wed" disabled> ${Lang.t('scheduler.day_wed')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="thu" disabled> ${Lang.t('scheduler.day_thu')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="fri" disabled> ${Lang.t('scheduler.day_fri')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="sat" disabled> ${Lang.t('scheduler.day_sat')}</label>
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" class="bot-day-check" value="sun" disabled> ${Lang.t('scheduler.day_sun')}</label>
                        </div>
                    </div>
                    <div id="bot-sched-msg" style="font-size:12px;margin-top:8px;"></div>
                </div>

                <!-- Liste des tâches -->
                ${taskList.length === 0 ? `
                    <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
                        <div style="font-size:28px;margin-bottom:8px;">📅</div>
                        ${Lang.t('bots.no_sched_tasks')}
                    </div>
                ` : `
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        ${taskList.map(t => {
                            const locale = Lang.t('common.locale') || 'fr-FR';
                            return `
                            <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                                <span style="font-size:18px;">${taskIcons[t.task_type] || '📋'}</span>
                                <div style="flex:1;">
                                    <div style="font-size:13px;font-weight:600;">${taskLabels[t.task_type] || t.task_type}</div>
                                    <div style="font-size:11px;color:var(--text-muted);">
                                        ${t.schedule_time ? ('⏰ ' + Lang.t('scheduler.at') + ' ' + t.schedule_time + ' (' + (t.schedule_days || 'daily') + ')') : ('⏰ ' + Lang.t('scheduler.every') + ' ' + t.interval_hours + 'h')}
                                        ${t.next_run ? ` · ${Lang.t('bots.next_run')}: ${new Date(t.next_run).toLocaleString(locale)}` : ''}
                                        ${t.last_run ? ` · ${Lang.t('bots.last_run')}: ${new Date(t.last_run).toLocaleString(locale)}` : ''}
                                    </div>
                                </div>
                                <div style="display:flex;gap:6px;align-items:center;">
                                    <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${t.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)'};color:${t.enabled ? 'var(--accent-green)' : 'var(--text-muted)'};">
                                        ${t.enabled ? '● ' + Lang.t('scheduler.active') : '○ ' + Lang.t('scheduler.inactive')}
                                    </span>
                                    <button class="btn btn-sm btn-secondary" onclick="BotsModule.toggleBotTask(${t.id}, ${botId})" title="${t.enabled ? 'Pause' : 'Resume'}">${t.enabled ? '⏸' : '▶️'}</button>
                                    <button class="btn btn-sm btn-secondary" onclick="BotsModule.deleteBotTask(${t.id}, ${botId})" style="color:#ef4444;" title="Delete">🗑️</button>
                                </div>
                            </div>`;
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
            if (msg) { msg.style.color = '#22c55e'; msg.textContent = Lang.t('scheduler.created'); }
            setTimeout(() => this.showScheduler(botId), 500);
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || Lang.t('common.error')}`; }
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
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">${Lang.t('bots.editor')} — ${bot?.name || 'Bot'}</h3>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span style="font-size:11px;color:var(--text-muted);">${Lang.t('bots.save_hint')}</span>
                        <span id="code-save-msg" style="font-size:12px;"></span>
                        <button class="btn btn-primary btn-sm" onclick="BotsModule.saveCode(${id})">💾 ${Lang.t('common.save')}</button>
                    </div>
                </div>
                <textarea id="bot-code-editor" spellcheck="false" style="width:100%;min-height:400px;background:#0d1117;color:#c9d1d9;border:1px solid var(--border-color);border-radius:8px;padding:16px;font-family:'Fira Code',monospace;font-size:13px;line-height:1.6;resize:vertical;tab-size:4;outline:none;">${data.code.replace(/</g,'&lt;')}</textarea>
            </div>`;
        // Support Tab dans l'éditeur
        const editor = document.getElementById('bot-code-editor');
        if (editor) {
            editor.addEventListener('keydown', (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = editor.selectionStart;
                    const end = editor.selectionEnd;
                    editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
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
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳...'; }

        const r = await Auth.apiCall(`/api/bots/${id}/code`, {
            method: 'PUT',
            body: JSON.stringify({ code })
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = Lang.t('bots.saved'); }
        } else {
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${Lang.t('common.error')}`; }
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

        container.innerHTML = `
            <div class="yield-header">
                <div class="yield-header-left">
                    <span class="yield-header-icon">🏦</span>
                    <div>
                        <h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('yield.subtitle')}</p>
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <span class="yield-usage-badge ${usageClass}">
                        📊 ${Lang.t('yield.usage')}: ${usage.today_runs}/${usage.max_runs}
                    </span>
                    <button class="btn btn-secondary btn-sm" onclick="BotsModule.render(BotsModule._container)">
                        ${Lang.t('yield.back_bots')}
                    </button>
                </div>
            </div>

            <div class="card" style="margin-bottom:20px;">
                <!-- Dropzone -->
                <div id="yield-dropzone" class="yield-dropzone ${hasFile ? 'has-file' : ''}"
                    ondragover="event.preventDefault();this.classList.add('dragover')"
                    ondragleave="this.classList.remove('dragover')"
                    ondrop="event.preventDefault();this.classList.remove('dragover');BotsModule._onYieldFileDrop(event)"
                    onclick="document.getElementById('yield-file-input').click()">
                    ${hasFile ? this._renderYieldFileInfo() : `
                        <span class="yield-dropzone-icon">📂</span>
                        <div class="yield-dropzone-text">${Lang.t('yield.upload_hint')}</div>
                    `}
                </div>
                <input type="file" id="yield-file-input" accept=".xlsx" style="display:none"
                    onchange="BotsModule._onYieldFileSelect(event)">

                <!-- Mode selector -->
                <div class="yield-modes">
                    <div class="yield-mode-option ${this._yieldState.mode === 'recalculate' ? 'selected' : ''}"
                        onclick="BotsModule._selectYieldMode('recalculate')">
                        <span class="yield-mode-icon">⚡</span>
                        <div class="yield-mode-label">${Lang.t('yield.mode_recalculate')}</div>
                        <div class="yield-mode-desc">${Lang.t('yield.mode_recalculate_desc')}</div>
                    </div>
                    <div class="yield-mode-option ${this._yieldState.mode === 'all' ? 'selected' : ''}"
                        onclick="BotsModule._selectYieldMode('all')">
                        <span class="yield-mode-icon">🌐</span>
                        <div class="yield-mode-label">${Lang.t('yield.mode_all')}</div>
                        <div class="yield-mode-desc">${Lang.t('yield.mode_all_desc')}</div>
                    </div>
                </div>

                <!-- Seuil prix coloration -->
                <div class="yield-threshold-container" style="margin-top:14px;padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <label style="font-size:13px;font-weight:600;">🎨 ${Lang.t('yield.threshold_label') || 'Seuil coloration prix'}</label>
                        <span id="yield-threshold-value" style="font-size:14px;font-weight:700;color:var(--accent-blue);min-width:40px;text-align:right;">${this._yieldState.priceThreshold}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span style="font-size:11px;color:var(--text-muted);">90</span>
                        <input type="range" id="yield-threshold-slider" min="90" max="110" step="0.5" value="${this._yieldState.priceThreshold}"
                            style="flex:1;accent-color:var(--accent-blue);cursor:pointer;"
                            oninput="BotsModule._onThresholdChange(this.value)">
                        <span style="font-size:11px;color:var(--text-muted);">110</span>
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
                        🔴 ${Lang.t('yield.threshold_above') || 'Rouge si prix'} &gt; <span id="yield-threshold-hint">${this._yieldState.priceThreshold}</span> · ⚫ ${Lang.t('yield.threshold_below') || 'Noir si prix'} ≤ <span id="yield-threshold-hint2">${this._yieldState.priceThreshold}</span>
                    </div>
                </div>

                <!-- Upload info / summary -->
                <div id="yield-upload-info" style="display:none;margin-top:12px;"></div>

                <!-- Launch button -->
                <button id="yield-launch-btn" class="yield-launch-btn" onclick="BotsModule._launchYieldBot()"
                    ${!hasFile ? 'disabled' : ''}>
                    ${Lang.t('yield.launch')}
                </button>

                <div id="yield-error-msg" style="display:none;margin-top:12px;color:var(--accent-red);font-size:13px;text-align:center;"></div>
            </div>
        `;
    },

    _renderYieldFileInfo() {
        const f = this._yieldState.file;
        if (!f) return '';
        const sizeKB = (f.size / 1024).toFixed(1);
        return `
            <div class="yield-file-info">
                <span class="yield-file-icon">📊</span>
                <div class="yield-file-details">
                    <div class="yield-file-name">${f.name}</div>
                    <div class="yield-file-meta">${sizeKB} KB</div>
                </div>
                <button class="yield-file-remove" onclick="event.stopPropagation();BotsModule._removeYieldFile()">✕</button>
            </div>
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
                <span class="yield-dropzone-icon">📂</span>
                <div class="yield-dropzone-text">${Lang.t('yield.upload_hint')}</div>
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
                mode === 'recalculate' ? '⚡' : '🌐'
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
                headers: {},  // Let browser set content-type with boundary
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
                errMsg.textContent = `❌ ${e.message}`;
            }
        }
    },

    _renderYieldRunning() {
        const container = this._container || document.getElementById('bots-module-container')?.parentElement;
        if (!container) return;

        const mode = this._yieldState.mode;
        const modeLabel = mode === 'all' ? Lang.t('yield.mode_all') : Lang.t('yield.mode_recalculate');

        container.innerHTML = `
            <div class="yield-header">
                <div class="yield-header-left">
                    <span class="yield-header-icon">🏦</span>
                    <div>
                        <h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')} — <span class="yield-pulse"></span>${Lang.t('yield.running')}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${this._yieldState.file?.name || ''} · ${modeLabel}</p>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom:16px;">
                <!-- Progress -->
                <div class="yield-progress-container">
                    <div class="yield-progress-bar">
                        <div id="yield-progress-fill" class="yield-progress-fill" style="width:0%"></div>
                    </div>
                    <div class="yield-progress-text">
                        <span id="yield-progress-label">${Lang.t('yield.processing')} 0/0</span>
                        <span id="yield-progress-percent" class="yield-progress-percent">0%</span>
                    </div>
                </div>

                <!-- Stats (mis à jour en live) -->
                <div class="yield-stats">
                    <div class="yield-stat-card success">
                        <div id="yield-stat-updated" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">✅ ${Lang.t('yield.updated')}</div>
                    </div>
                    <div class="yield-stat-card warning">
                        <div id="yield-stat-skipped" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">⚠️ ${Lang.t('yield.skipped')}</div>
                    </div>
                    <div class="yield-stat-card error">
                        <div id="yield-stat-errors" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">❌ ${Lang.t('yield.errors')}</div>
                    </div>
                </div>
            </div>

            <!-- Logs terminal -->
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 ${Lang.t('yield.logs')}</h3>
                    ${mode === 'all' ? `<button class="btn btn-danger btn-sm" onclick="BotsModule._stopYieldBot()">${Lang.t('yield.stop')}</button>` : ''}
                </div>
                <div id="yield-logs" class="yield-terminal">
                    <div style="color:#6b7280;text-align:center;padding:20px;">⏳ ${Lang.t('yield.running')}</div>
                </div>
            </div>
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
                    <div class="yield-log-line">
                        <span class="yield-log-num">${i + 1}</span>
                        <span class="yield-log-content">${l.replace(/</g, '&lt;')}</span>
                    </div>
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
        const statusIcon = isSuccess ? '✅' : data.status === 'error' ? '❌' : '⏹';
        const statusLabel = isSuccess ? Lang.t('yield.completed') : data.status === 'error' ? Lang.t('yield.error') : Lang.t('yield.stopped');

        container.innerHTML = `
            <div class="yield-header">
                <div class="yield-header-left">
                    <span class="yield-header-icon">🏦</span>
                    <div>
                        <h1 style="margin:0;font-size:22px;">${Lang.t('yield.title')} — ${statusIcon} ${statusLabel}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${data.filename || ''}</p>
                    </div>
                </div>
            </div>

            <!-- Stats résumé -->
            <div class="card" style="margin-bottom:16px;">
                <h3 style="margin:0 0 16px;">📊 ${Lang.t('yield.summary')}</h3>

                <div class="yield-stats">
                    <div class="yield-stat-card success">
                        <div class="yield-stat-value">${data.stats?.updated || 0}</div>
                        <div class="yield-stat-label">✅ ${Lang.t('yield.updated')}</div>
                    </div>
                    <div class="yield-stat-card warning">
                        <div class="yield-stat-value">${data.stats?.skipped || 0}</div>
                        <div class="yield-stat-label">⚠️ ${Lang.t('yield.skipped')}</div>
                    </div>
                    <div class="yield-stat-card error">
                        <div class="yield-stat-value">${data.stats?.errors || 0}</div>
                        <div class="yield-stat-label">❌ ${Lang.t('yield.errors')}</div>
                    </div>
                </div>

                <!-- Progress bar complète -->
                <div class="yield-progress-container" style="margin-top:16px;">
                    <div class="yield-progress-bar">
                        <div class="yield-progress-fill" style="width:${data.progress_percent || 0}%;${!isSuccess ? 'background:linear-gradient(90deg,var(--accent-yellow),var(--accent-red));' : ''}"></div>
                    </div>
                    <div class="yield-progress-text" style="margin-top:4px;">
                        <span>${data.progress || ''}</span>
                        <span class="yield-progress-percent">${data.progress_percent || 0}%</span>
                    </div>
                </div>

                <!-- Actions -->
                <div style="display:flex;gap:12px;margin-top:20px;">
                    ${isSuccess && data.result_file ? `
                        <button class="yield-launch-btn" style="flex:1;margin-top:0;" onclick="BotsModule._downloadYieldResult()">
                            ${Lang.t('yield.download')}
                        </button>
                    ` : ''}
                    ${data.status === 'stopped' && this._yieldState.processedCount > 0 ? `
                        <button class="yield-launch-btn" style="flex:1;margin-top:0;background:linear-gradient(135deg,#f59e0b,#ef4444);" onclick="BotsModule._resumeYieldBot()">
                            ▶ ${Lang.t('yield.resume')} (${Lang.t('yield.from_bond')} ${this._yieldState.processedCount + 1})
                        </button>
                    ` : ''}
                    <button class="btn btn-secondary" style="flex:1;padding:14px;font-size:15px;font-weight:600;" onclick="BotsModule._startNewYieldJob()">
                        ${Lang.t('yield.restart')}
                    </button>
                </div>
            </div>

            <!-- Logs -->
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 ${Lang.t('yield.logs')} (${data.logs_count || data.logs?.length || 0} ${Lang.t('bots.lines')})</h3>
                </div>
                <div class="yield-terminal">
                    ${data.logs && data.logs.length > 0
                        ? data.logs.map((l, i) => `
                            <div class="yield-log-line">
                                <span class="yield-log-num">${i + 1}</span>
                                <span class="yield-log-content">${l.replace(/</g, '&lt;')}</span>
                            </div>
                        `).join('')
                        : '<div style="color:#6b7280;text-align:center;padding:20px;">No logs</div>'
                    }
                </div>
            </div>
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
        minRating: 'BBB-',
        maxResults: 50,
        currencies: { EUR: true, USD: true, GBP: true },
        priceThreshold: 101,
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
            <div class="yield-header">
                <div class="yield-header-left">
                    <span class="yield-header-icon">🔍</span>
                    <div>
                        <h1 style="margin:0;font-size:22px;">${Lang.t('scanner.title')}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('scanner.subtitle')}</p>
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <span class="yield-usage-badge ${usageClass}">
                        📊 ${Lang.t('scanner.usage')}: ${usage.today_scans}/${usage.max_scans}
                    </span>
                    <button class="btn btn-secondary btn-sm" onclick="BotsModule.render(BotsModule._container)">
                        ${Lang.t('scanner.back_bots')}
                    </button>
                </div>
            </div>

            <div class="card" style="margin-bottom:20px;">
                <h3 style="margin:0 0 16px;">${Lang.t('scanner.config_title')}</h3>
                <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">${Lang.t('scanner.criteria_desc')}</p>

                <!-- Prezzo massimo -->
                <div class="yield-threshold-container" style="margin-bottom:14px;padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <label style="font-size:13px;font-weight:600;">💰 ${Lang.t('scanner.max_price')}</label>
                        <span id="scanner-price-value" style="font-size:14px;font-weight:700;color:#10b981;">${s.maxPrice}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span style="font-size:11px;color:var(--text-muted);">85</span>
                        <input type="range" id="scanner-price-slider" min="85" max="110" step="0.5" value="${s.maxPrice}"
                            style="flex:1;accent-color:#10b981;cursor:pointer;"
                            oninput="BotsModule._scannerState.maxPrice=parseFloat(this.value);document.getElementById('scanner-price-value').textContent=this.value">
                        <span style="font-size:11px;color:var(--text-muted);">110</span>
                    </div>
                </div>

                <!-- Yield minimo -->
                <div class="yield-threshold-container" style="margin-bottom:14px;padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <label style="font-size:13px;font-weight:600;">📈 ${Lang.t('scanner.min_yield')}</label>
                        <span id="scanner-yield-value" style="font-size:14px;font-weight:700;color:#10b981;">${s.minYield}%</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span style="font-size:11px;color:var(--text-muted);">1%</span>
                        <input type="range" id="scanner-yield-slider" min="1" max="10" step="0.5" value="${s.minYield}"
                            style="flex:1;accent-color:#10b981;cursor:pointer;"
                            oninput="BotsModule._scannerState.minYield=parseFloat(this.value);document.getElementById('scanner-yield-value').textContent=this.value+'%'">
                        <span style="font-size:11px;color:var(--text-muted);">10%</span>
                    </div>
                </div>

                <!-- Numero massimo di bond -->
                <div class="yield-threshold-container" style="margin-bottom:14px;padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <label style="font-size:13px;font-weight:600;">🎯 ${Lang.t('scanner.max_results')}</label>
                        <span id="scanner-maxresults-value" style="font-size:14px;font-weight:700;color:#10b981;">${s.maxResults === 0 ? '∞' : s.maxResults}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span style="font-size:11px;color:var(--text-muted);">10</span>
                        <input type="range" id="scanner-maxresults-slider" min="10" max="200" step="10" value="${s.maxResults || 50}"
                            style="flex:1;accent-color:#10b981;cursor:pointer;"
                            oninput="BotsModule._scannerState.maxResults=parseInt(this.value);document.getElementById('scanner-maxresults-value').textContent=this.value">
                        <span style="font-size:11px;color:var(--text-muted);">200</span>
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${Lang.t('scanner.max_results_hint')}</div>
                </div>

                <!-- Scadenza + Rating + Valute -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
                    <div style="padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);">
                        <label style="font-size:13px;font-weight:600;">📅 ${Lang.t('scanner.maturity')}</label>
                        <select id="scanner-maturity" class="form-input" style="margin-top:8px;"
                            onchange="BotsModule._scannerState.maxMaturity=parseInt(this.value)">
                            <option value="5" ${s.maxMaturity===5?'selected':''}>5 anni</option>
                            <option value="7" ${s.maxMaturity===7?'selected':''}>7 anni</option>
                            <option value="9" ${s.maxMaturity===9?'selected':''}>9 anni</option>
                            <option value="12" ${s.maxMaturity===12?'selected':''}>12 anni</option>
                            <option value="15" ${s.maxMaturity===15?'selected':''}>15 anni</option>
                        </select>
                    </div>
                    <div style="padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);">
                        <label style="font-size:13px;font-weight:600;">⭐ ${Lang.t('scanner.rating')}</label>
                        <select id="scanner-rating" class="form-input" style="margin-top:8px;"
                            onchange="BotsModule._scannerState.minRating=this.value">
                            <option value="BBB-" ${s.minRating==='BBB-'?'selected':''}>BBB- (Investment Grade)</option>
                            <option value="BBB" ${s.minRating==='BBB'?'selected':''}>BBB</option>
                            <option value="A-" ${s.minRating==='A-'?'selected':''}>A-</option>
                            <option value="A" ${s.minRating==='A'?'selected':''}>A</option>
                        </select>
                    </div>
                </div>

                <!-- Valute -->
                <div style="padding:12px 16px;background:var(--bg-primary);border-radius:10px;border:1px solid var(--border-color);margin-bottom:20px;">
                    <label style="font-size:13px;font-weight:600;margin-bottom:8px;display:block;">🌍 ${Lang.t('scanner.currencies')}</label>
                    <div style="display:flex;gap:12px;">
                        <label style="font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;">
                            <input type="checkbox" id="scanner-eur" ${s.currencies.EUR?'checked':''}
                                onchange="BotsModule._scannerState.currencies.EUR=this.checked"> 🇪🇺 EUR
                        </label>
                        <label style="font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;">
                            <input type="checkbox" id="scanner-usd" ${s.currencies.USD?'checked':''}
                                onchange="BotsModule._scannerState.currencies.USD=this.checked"> 🇺🇸 USD
                        </label>
                        <label style="font-size:13px;cursor:pointer;display:flex;align-items:center;gap:4px;">
                            <input type="checkbox" id="scanner-gbp" ${s.currencies.GBP?'checked':''}
                                onchange="BotsModule._scannerState.currencies.GBP=this.checked"> 🇬🇧 GBP
                        </label>
                    </div>
                </div>

                <!-- Launch button -->
                <button id="scanner-launch-btn" class="yield-launch-btn" style="background:linear-gradient(135deg,#10b981,#059669);"
                    onclick="BotsModule._launchScanner()" ${usage.remaining===0?'disabled':''}>
                    ${usage.remaining === 0 ? Lang.t('scanner.rate_limit') : Lang.t('scanner.launch')}
                </button>

                <div id="scanner-error-msg" style="display:none;margin-top:12px;color:var(--accent-red);font-size:13px;text-align:center;"></div>
            </div>
        `;
    },

    async _launchScanner() {
        const btn = document.getElementById('scanner-launch-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
        const errMsg = document.getElementById('scanner-error-msg');
        if (errMsg) errMsg.style.display = 'none';

        const s = this._scannerState;
        const currencies = Object.entries(s.currencies).filter(([,v]) => v).map(([k]) => k).join(',');
        if (!currencies) {
            if (errMsg) { errMsg.style.display = 'block'; errMsg.textContent = '❌ Seleziona almeno una valuta'; }
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
                    max_results: s.maxResults || 0,
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
            if (errMsg) { errMsg.style.display = 'block'; errMsg.textContent = `❌ ${e.message}`; }
        }
    },

    _renderScannerRunning() {
        const container = this._container || document.getElementById('bots-module-container')?.parentElement;
        if (!container) return;

        container.innerHTML = `
            <div class="yield-header">
                <div class="yield-header-left">
                    <span class="yield-header-icon">🔍</span>
                    <div>
                        <h1 style="margin:0;font-size:22px;">${Lang.t('scanner.title')} — <span class="yield-pulse"></span>${Lang.t('scanner.running')}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('scanner.subtitle')}</p>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom:16px;">
                <div class="yield-progress-container">
                    <div class="yield-progress-bar">
                        <div id="scanner-progress-fill" class="yield-progress-fill" style="width:0%;background:linear-gradient(90deg,#10b981,#059669);"></div>
                    </div>
                    <div class="yield-progress-text">
                        <span id="scanner-progress-label">${Lang.t('scanner.running')}</span>
                        <span id="scanner-progress-percent" class="yield-progress-percent">0%</span>
                    </div>
                </div>

                <div class="yield-stats">
                    <div class="yield-stat-card" style="border-left:3px solid var(--accent-blue);">
                        <div id="scanner-stat-scanned" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">📡 ${Lang.t('scanner.scanned')}</div>
                    </div>
                    <div class="yield-stat-card success">
                        <div id="scanner-stat-found" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">✅ ${Lang.t('scanner.found')}</div>
                    </div>
                    <div class="yield-stat-card warning">
                        <div id="scanner-stat-discarded" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">⚠️ ${Lang.t('scanner.discarded')}</div>
                    </div>
                    <div class="yield-stat-card error">
                        <div id="scanner-stat-errors" class="yield-stat-value">0</div>
                        <div class="yield-stat-label">❌ ${Lang.t('scanner.errors')}</div>
                    </div>
                </div>
            </div>

            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 Log</h3>
                    <button class="btn btn-danger btn-sm" onclick="BotsModule._stopScanner()">${Lang.t('scanner.stop')}</button>
                </div>
                <div id="scanner-logs" class="yield-terminal">
                    <div style="color:#6b7280;text-align:center;padding:20px;">⏳ ${Lang.t('scanner.running')}</div>
                </div>
            </div>
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
            if (label && cc.length > 0) label.textContent = `✅ ${cc.join(', ')}`;

            const ss = data.stats || {};
            const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v || 0; };
            el('scanner-stat-scanned', ss.total_scanned);
            el('scanner-stat-found', ss.total_filtered);
            el('scanner-stat-discarded', ss.total_discarded);
            el('scanner-stat-errors', ss.total_errors);

            const logsEl = document.getElementById('scanner-logs');
            if (logsEl && data.logs && data.logs.length > 0) {
                logsEl.innerHTML = data.logs.map((l, i) => `
                    <div class="yield-log-line">
                        <span class="yield-log-num">${i + 1}</span>
                        <span class="yield-log-content">${l.replace(/</g, '&lt;')}</span>
                    </div>
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
        const statusIcon = isSuccess ? '✅' : data.status === 'error' ? '❌' : '⏹';
        const statusLabel = isSuccess ? Lang.t('scanner.completed') : data.status === 'error' ? Lang.t('scanner.error') : Lang.t('scanner.stopped');
        const ss = data.stats || {};

        container.innerHTML = `
            <div class="yield-header">
                <div class="yield-header-left">
                    <span class="yield-header-icon">🔍</span>
                    <div>
                        <h1 style="margin:0;font-size:22px;">${Lang.t('scanner.title')} — ${statusIcon} ${statusLabel}</h1>
                        <p style="color:var(--text-muted);font-size:13px;margin-top:2px;">${Lang.t('scanner.subtitle')}</p>
                    </div>
                </div>
            </div>

            <div class="card" style="margin-bottom:16px;">
                <h3 style="margin:0 0 16px;">📊 ${Lang.t('scanner.summary')}</h3>
                <div class="yield-stats">
                    <div class="yield-stat-card" style="border-left:3px solid var(--accent-blue);">
                        <div class="yield-stat-value">${ss.total_scanned || 0}</div>
                        <div class="yield-stat-label">📡 ${Lang.t('scanner.scanned')}</div>
                    </div>
                    <div class="yield-stat-card success">
                        <div class="yield-stat-value">${ss.total_filtered || 0}</div>
                        <div class="yield-stat-label">✅ ${Lang.t('scanner.found')}</div>
                    </div>
                    <div class="yield-stat-card warning">
                        <div class="yield-stat-value">${ss.total_discarded || 0}</div>
                        <div class="yield-stat-label">⚠️ ${Lang.t('scanner.discarded')}</div>
                    </div>
                    <div class="yield-stat-card error">
                        <div class="yield-stat-value">${ss.total_errors || 0}</div>
                        <div class="yield-stat-label">❌ ${Lang.t('scanner.errors')}</div>
                    </div>
                </div>

                <div style="display:flex;gap:12px;margin-top:20px;">
                    ${isSuccess && data.result_file ? `
                        <button class="yield-launch-btn" style="flex:1;margin-top:0;background:linear-gradient(135deg,#10b981,#059669);" onclick="BotsModule._downloadScannerResult()">
                            ${Lang.t('scanner.download')}
                        </button>
                    ` : ''}
                    <button class="btn btn-secondary" style="flex:1;padding:14px;font-size:15px;font-weight:600;" onclick="BotsModule._startNewScan()">
                        ${Lang.t('scanner.restart')}
                    </button>
                </div>
            </div>

            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 Log (${data.logs_count || data.logs?.length || 0} ${Lang.t('bots.lines')})</h3>
                </div>
                <div class="yield-terminal">
                    ${data.logs && data.logs.length > 0
                        ? data.logs.map((l, i) => `
                            <div class="yield-log-line">
                                <span class="yield-log-num">${i + 1}</span>
                                <span class="yield-log-content">${l.replace(/</g, '&lt;')}</span>
                            </div>
                        `).join('')
                        : '<div style="color:#6b7280;text-align:center;padding:20px;">No logs</div>'
                    }
                </div>
            </div>
        `;
    },

    async _downloadScannerResult() {
        const jobId = this._scannerState.jobId;
        if (!jobId) return;
        const token = Auth.getToken();
        if (!token) return;
        // Utilise un lien direct avec token — plus fiable via Cloudflare
        const today = new Date().toISOString().slice(0, 10);
        const filename = `Opportunita_Bond_${today}.xlsx`;
        window.open(`/api/bots/scanner/download-file/${jobId}/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`, '_blank');
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

