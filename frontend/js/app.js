/**
 * App.js — Routeur et logique principale de l'application.
 * 
 * Gère la navigation entre les vues (hub, modules, settings)
 * sans recharger la page. C'est le chef d'orchestre du frontend.
 */

const App = {
    // Vue actuellement affichée
    currentView: 'hub',

    /**
     * Initialisation au chargement de la page.
     */
    async init() {
        // Vérifier si l'utilisateur est connecté
        if (!Auth.isLoggedIn()) {
            window.location.href = '/login';
            return;
        }

        // Rafraîchir les infos utilisateur depuis l'API (rôle, admin, etc.)
        await this.refreshUserInfo();

        // Afficher les infos utilisateur dans la sidebar
        this.updateUserInfo();

        // Déterminer la vue initiale depuis le hash de l'URL
        const initialView = this._getViewFromHash() || 'hub';

        // Charger la vue initiale (sans push dans l'historique)
        this._skipPush = true;
        await this.navigateTo(initialView);
        this._skipPush = false;

        // Remplacer l'état initial (pas push) pour que le premier back fonctionne
        history.replaceState({ view: initialView }, '', `#${initialView}`);

        // Écouter les boutons back/forward du navigateur
        window.addEventListener('popstate', (e) => this._handlePopState(e));

        // Démarrer le monitoring
        Monitoring.start();

        // Charger le thème sauvegardé
        this._loadTheme();

        // Appliquer la langue sauvegardée sur la sidebar
        if (typeof Lang !== 'undefined') Lang._updateSidebar();
    },

    /**
     * Extrait la vue depuis le hash de l'URL.
     * Ex: "#bots" → "bots", "#server_view/3" → null (traité séparément)
     */
    _getViewFromHash() {
        const hash = window.location.hash.replace('#', '');
        if (!hash) return null;
        // server_view/ID → retourne 'game_server' (on ne peut pas restaurer un server_view sans contexte complet)
        if (hash.startsWith('server_view')) return 'game_server';
        const validViews = ['hub', 'game_server', 'bots', 'files', 'media', 'web', 'network', 'settings', 'users'];
        return validViews.includes(hash) ? hash : null;
    },

    /**
     * Gère les boutons back/forward du navigateur.
     */
    _handlePopState(event) {
        const state = event.state;
        const view = state?.view || this._getViewFromHash() || 'hub';

        // Naviguer sans re-pusher dans l'historique
        this._skipPush = true;
        this.navigateTo(view).then(() => {
            this._skipPush = false;
        });
    },

    // === THÈMES ===
    _themes: ['default', 'midnight', 'emerald', 'crimson'],
    _themeNames: { default: '🌑 Défaut', midnight: '🌊 Midnight', emerald: '🌲 Emerald', crimson: '🔥 Crimson' },

    _loadTheme() {
        const saved = localStorage.getItem('omen-theme') || 'default';
        const isLight = localStorage.getItem('omen-light') === 'true';
        document.documentElement.setAttribute('data-theme', isLight ? 'light' : saved);
        // Update light mode button icon
        const lmBtn = document.getElementById('lightmode-btn');
        if (lmBtn) lmBtn.textContent = isLight ? '🌞' : '🌗';
    },

    cycleTheme() {
        // Only cycle dark themes — light mode is separate toggle
        if (localStorage.getItem('omen-light') === 'true') return;
        const current = localStorage.getItem('omen-theme') || 'default';
        const idx = this._themes.indexOf(current);
        const next = this._themes[(idx + 1) % this._themes.length];
        localStorage.setItem('omen-theme', next);
        document.documentElement.setAttribute('data-theme', next);

        // Feedback visuel
        const btn = document.getElementById('theme-btn');
        if (btn) {
            btn.title = this._themeNames[next];
            btn.style.transform = 'rotate(360deg)';
            setTimeout(() => btn.style.transform = '', 300);
        }
        if (typeof Toast !== 'undefined') Toast.info(`${Lang.t('toast.theme')} ${this._themeNames[next]}`);
    },

    toggleLightMode() {
        const isLight = localStorage.getItem('omen-light') === 'true';
        const newMode = !isLight;
        localStorage.setItem('omen-light', newMode.toString());
        const theme = newMode ? 'light' : (localStorage.getItem('omen-theme') || 'default');
        document.documentElement.setAttribute('data-theme', theme);
        const lmBtn = document.getElementById('lightmode-btn');
        if (lmBtn) lmBtn.textContent = newMode ? '🌞' : '🌗';
        if (typeof Toast !== 'undefined') Toast.info(newMode ? Lang.t('toast.light_on') : Lang.t('toast.light_off'));
    },

    /**
     * Rafraîchit les infos utilisateur depuis l'API.
     * Important pour synchroniser le rôle et is_admin après un changement de DB.
     */
    async refreshUserInfo() {
        const response = await Auth.apiCall('/api/auth/me');
        if (response && response.ok) {
            const user = await response.json();
            localStorage.setItem(Auth.USER_KEY, JSON.stringify(user));
        }
    },

    /**
     * Met à jour les infos utilisateur dans la sidebar.
     */
    updateUserInfo() {
        const user = Auth.getUser();
        if (!user) return;

        const nameEl = document.getElementById('user-name');
        const avatarEl = document.getElementById('user-avatar');
        const roleEl = document.getElementById('user-role');

        if (nameEl) nameEl.textContent = user.username;
        if (avatarEl) avatarEl.textContent = user.username.charAt(0).toUpperCase();
        if (roleEl) {
            const roleKey = `users.role_${user.role || 'player'}`;
            roleEl.textContent = Lang.t(roleKey) || (user.is_admin ? Lang.t('users.admin_label') : Lang.t('users.user_label'));
        }

        // Afficher le lien Utilisateurs et Réseau seulement pour les admins
        const navUsers = document.getElementById('nav-users');
        if (navUsers) navUsers.style.display = user.is_admin ? '' : 'none';
        const navNetwork = document.getElementById('nav-network');
        if (navNetwork) navNetwork.style.display = user.is_admin ? '' : 'none';

        // Masquer les modules non autorisés dans la sidebar
        const moduleIds = ['game_server', 'bots', 'files', 'media', 'web'];
        moduleIds.forEach(modId => {
            const navEl = document.getElementById(`nav-${modId}`);
            if (!navEl) return;
            if (user.is_admin || !user.allowed_modules) {
                navEl.style.display = '';  // Admin ou null = tout visible
            } else {
                navEl.style.display = user.allowed_modules.includes(modId) ? '' : 'none';
            }
        });
    },

    /**
     * Navigation entre les vues.
     * C'est la fonction principale qui change le contenu affiché.
     */
    async navigateTo(view, data) {
        // Fermer le menu mobile si ouvert
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('active');

        // Décharger la vue précédente
        if (this.currentView === 'game_server') {
            GameServer.unload();
        }
        if (this.currentView === 'server_view') {
            ServerView.close();
        }
        if (this.currentView === 'bots' && typeof BotsModule !== 'undefined') {
            BotsModule.unload();
        }
        if (this.currentView === 'media' && typeof MediaModule !== 'undefined') {
            MediaModule.unload();
        }
        if (this.currentView === 'web' && typeof WebModule !== 'undefined') {
            WebModule.unload();
        }
        if (this.currentView === 'network' && typeof NetworkModule !== 'undefined') {
            NetworkModule.unload();
        }

        this.currentView = view;

        // Enregistrer dans l'historique du navigateur (sauf si on gère un popstate)
        if (!this._skipPush) {
            const hashView = view === 'server_view' ? `server_view/${data || ''}` : view;
            history.pushState({ view, data }, '', `#${hashView}`);
        }

        // Mettre à jour la sidebar
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view || (view === 'server_view' && item.dataset.view === 'game_server'));
        });

        const content = document.getElementById('module-content');
        if (!content) return;

        // Supprimer le padding pour la vue serveur (sidebar doit coller au bord)
        content.classList.toggle('sv-fullscreen', view === 'server_view');

        // Vérifier l'accès admin pour le module Réseau
        const user = Auth.getUser();
        if (view === 'network' && user && !user.is_admin) {
            content.innerHTML = `
                <div class="text-center" style="padding: 60px; color: var(--text-muted);">
                    <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
                    <p style="font-size:16px;font-weight:600;color:var(--text-primary);">${Lang.t('access.denied')}</p>
                    <p style="margin-top:8px;">${Lang.t('access.denied_msg')}</p>
                    <button class="btn btn-secondary mt-4" onclick="App.navigateTo('hub')">${Lang.t('access.back')}</button>
                </div>
            `;
            return;
        }

        // Vérifier l'accès au module (non-admin seulement)
        const moduleViews = ['game_server', 'bots', 'files', 'media', 'web'];
        if (moduleViews.includes(view) && user && !user.is_admin && user.allowed_modules) {
            if (!user.allowed_modules.includes(view)) {
                content.innerHTML = `
                    <div class="text-center" style="padding: 60px; color: var(--text-muted);">
                        <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
                        <p style="font-size:16px;font-weight:600;color:var(--text-primary);">${Lang.t('access.denied')}</p>
                        <p style="margin-top:8px;">${Lang.t('access.denied_msg')}</p>
                        <button class="btn btn-secondary mt-4" onclick="App.navigateTo('hub')">${Lang.t('access.back')}</button>
                    </div>
                `;
                return;
            }
        }

        switch (view) {
            case 'hub':
                this.renderHub(content);
                await Modules.loadHub();
                break;

            case 'game_server':
                await GameServer.load();
                break;

            case 'server_view':
                await ServerView.open(data);
                break;

            case 'settings':
                this.renderSettings(content);
                break;

            case 'users':
                this.renderUsers(content);
                break;

            case 'bots':
                await BotsModule.render(content);
                break;

            case 'files':
                await FilesModule.render(content);
                break;

            case 'media':
                await MediaModule.render(content);
                break;

            case 'web':
                await WebModule.render(content);
                break;

            case 'network':
                await NetworkModule.render(content);
                break;

            default:
                content.innerHTML = `
                    <div class="text-center" style="padding: 60px; color: var(--text-muted);">
                        <div style="font-size: 48px; margin-bottom: 16px;">🚧</div>
                        <p>${Lang.t('module.unavailable')}</p>
                        <button class="btn btn-secondary mt-4" onclick="App.navigateTo('hub')">${Lang.t('access.back')}</button>
                    </div>
                `;
        }
    },

    /**
     * Affiche la vue Hub avec le monitoring + les modules.
     */
    renderHub(content) {
        const t = (k) => Lang.t(k);
        content.innerHTML = `
            <div class="page-header">
                <h1 class="page-title">${t('dashboard.title')}</h1>
                <p class="page-subtitle">${t('dashboard.overview')}</p>
            </div>

            <!-- Stats monitoring -->
            <div class="stats-grid">
                <div class="stat-card" style="--stat-color: var(--accent-green)">
                    <div class="stat-label">CPU <span style="font-size:10px;color:var(--text-muted);font-weight:400;">${t('dashboard.disk_combined')}</span></div>
                    <div class="stat-value"><span id="stat-cpu-value">--</span><span class="stat-unit">%</span></div>
                    <div id="stat-cpu-machines" class="stat-machines-list"></div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-cpu-bar" style="width: 0%"></div></div>
                </div>
                <div class="stat-card" style="--stat-color: var(--accent-blue)">
                    <div class="stat-label">${t('dashboard.memory')} <span style="font-size:10px;color:var(--text-muted);font-weight:400;">${t('dashboard.disk_combined')}</span></div>
                    <div class="stat-value"><span id="stat-memory-value">--</span><span class="stat-unit">%</span></div>
                    <div id="stat-memory-detail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">-- / -- Go</div>
                    <div id="stat-memory-machines" class="stat-machines-list"></div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-memory-bar" style="width: 0%"></div></div>
                </div>
                <div class="stat-card" style="--stat-color: var(--accent-purple)">
                    <div class="stat-label">${t('dashboard.disk')} <span style="font-size:10px;color:var(--text-muted);font-weight:400;">${t('dashboard.disk_combined')}</span></div>
                    <div class="stat-value"><span id="stat-disk-value">--</span><span class="stat-unit">%</span></div>
                    <div id="stat-disk-detail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">-- / -- Go</div>
                    <div id="stat-disk-machines" class="stat-machines-list"></div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-disk-bar" style="width: 0%"></div></div>
                </div>
                <div class="stat-card" style="--stat-color: var(--accent-yellow)">
                    <div class="stat-label">${t('dashboard.temp')} <span style="font-size:10px;color:var(--text-muted);font-weight:400;">max</span></div>
                    <div class="stat-value"><span id="stat-temp-value">--</span><span class="stat-unit">°C</span></div>
                    <div id="stat-temp-machines" class="stat-machines-list"></div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-temp-bar" style="width: 0%"></div></div>
                </div>
            </div>

            <!-- Réseau -->
            <div style="margin-bottom: 28px; font-size: 13px; color: var(--text-muted);">
                🌐 ${t('dashboard.network')} : <span id="stat-network">--</span>
            </div>

            <!-- Kill All + Diagnostic -->
            <div style="display:flex;gap:12px;margin-bottom:28px;align-items:center;">
                <button class="btn btn-kill-all" onclick="App.killAllServers()" title="${t('dashboard.kill_all')}">
                    🔴 ${t('dashboard.kill_all')}
                </button>
                <button class="btn btn-secondary" onclick="App.runDiagnostic()" id="diag-btn" style="display:flex;align-items:center;gap:6px;">
                    🩺 ${t('dashboard.diagnostic')}
                </button>
                <span style="font-size:12px;color:var(--text-muted);">${t('dashboard.quick_actions')}</span>
            </div>

            <!-- Diagnostic auto (caché par défaut) -->
            <div id="diagnostic-panel" style="display:none;margin-bottom:28px;"></div>


            <!-- Modules -->
            <div class="page-header">
                <h2 style="font-size: 18px; font-weight: 700;">${t('modules.title')}</h2>
            </div>
            <div id="modules-grid" class="modules-grid"></div>

            <!-- Planification globale -->
            <div class="page-header" style="margin-top:28px;">
                <h2 style="font-size: 18px; font-weight: 700;">${t('scheduler.title')}</h2>
                <p class="page-subtitle">${t('scheduler.subtitle')}</p>
            </div>
            <div id="hub-scheduler" style="background:var(--bg-secondary);border-radius:12px;padding:20px;border:1px solid var(--border-color);">
                <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">${t('scheduler.loading')}</div>
            </div>
        `;

        // Charger les tâches planifiées de tous les serveurs
        this._loadGlobalSchedule();
    },

    async _loadGlobalSchedule() {
        const schedEl = document.getElementById('hub-scheduler');
        if (!schedEl) return;

        // Charger serveurs + bots en parallèle
        const [sr, br] = await Promise.all([
            Auth.apiCall('/api/servers'),
            Auth.apiCall('/api/bots'),
        ]);
        const servers = (sr && sr.ok) ? await sr.json() : [];
        const bots = (br && br.ok) ? await br.json() : [];

        if (servers.length === 0 && bots.length === 0) {
            schedEl.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:20px;">${Lang.t('scheduler.no_servers')}</div>`;
            return;
        }

        // Charger toutes les tâches (serveurs + bots)
        let allTasks = [];
        for (const s of servers) {
            const tr = await Auth.apiCall(`/api/scheduler/server/${s.id}`);
            if (tr && tr.ok) {
                const data = await tr.json();
                const tasks = data.tasks || data || [];
                if (Array.isArray(tasks)) {
                    tasks.forEach(t => allTasks.push({...t, targetName: s.name, targetIcon: '🎮', targetType: 'server'}));
                }
            }
        }
        for (const b of bots) {
            const tr = await Auth.apiCall(`/api/scheduler/bot/${b.id}`);
            if (tr && tr.ok) {
                const data = await tr.json();
                const tasks = data.tasks || data || [];
                if (Array.isArray(tasks)) {
                    tasks.forEach(t => allTasks.push({...t, targetName: b.name, targetIcon: '🤖', targetType: 'bot'}));
                }
            }
        }

        // Options pour le formulaire
        const serverOptions = servers.map(s => `<option value="server_${s.id}">🎮 ${s.name}</option>`).join('');
        const botOptions = bots.map(b => `<option value="bot_${b.id}">🤖 ${b.name}</option>`).join('');
        const targetOptions = serverOptions + botOptions;

        const formHTML = `
            <div id="hub-schedule-form" style="display:none;margin-bottom:12px;padding:14px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
                    <div style="flex:1;min-width:140px;">
                        <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.target')}</label>
                        <select id="hub-sched-target" class="form-input" style="margin-top:4px;" onchange="App._onScheduleTargetChange()">${targetOptions}</select>
                    </div>
                    <div style="flex:1;min-width:140px;">
                        <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.type')}</label>
                        <select id="hub-sched-type" class="form-input" style="margin-top:4px;">
                            <option value="backup">💾 ${Lang.t('scheduler.backup')}</option>
                            <option value="restart">🔄 ${Lang.t('scheduler.restart')}</option>
                        </select>
                    </div>
                    <div style="flex:1;min-width:110px;">
                        <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.mode')}</label>
                        <select id="hub-sched-mode" class="form-input" style="margin-top:4px;" onchange="App._onScheduleModeChange()">
                            <option value="interval">⏰ ${Lang.t('scheduler.mode_interval')}</option>
                            <option value="fixed">📅 ${Lang.t('scheduler.mode_fixed')}</option>
                        </select>
                    </div>
                </div>
                <!-- Mode intervalle -->
                <div id="hub-sched-interval-row" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:8px;">
                    <div style="flex:1;min-width:100px;">
                        <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.interval')}</label>
                        <select id="hub-sched-interval" class="form-input" style="margin-top:4px;">
                            <option value="1">1h</option>
                            <option value="6" selected>6h</option>
                            <option value="12">12h</option>
                            <option value="24">24h</option>
                            <option value="168">${Lang.t('scheduler.week')}</option>
                        </select>
                    </div>
                    <button class="btn btn-primary" onclick="App._createScheduledTask()">➕ ${Lang.t('scheduler.add')}</button>
                </div>
                <!-- Mode heure fixe -->
                <div id="hub-sched-fixed-row" style="display:none;margin-top:8px;">
                    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
                        <div>
                            <label style="font-size:12px;color:var(--text-muted);">${Lang.t('scheduler.time')}</label>
                            <input type="time" id="hub-sched-time" class="form-input" style="margin-top:4px;" value="08:00" />
                        </div>
                        <button class="btn btn-primary" onclick="App._createScheduledTask()">➕ ${Lang.t('scheduler.add')}</button>
                    </div>
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                        <label style="font-size:12px;color:var(--text-muted);margin-right:4px;">${Lang.t('scheduler.days')}:</label>
                        <label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="hub-day-daily" checked onchange="App._onDailyToggle(this)"> ${Lang.t('scheduler.daily')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="mon" disabled> ${Lang.t('scheduler.day_mon')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="tue" disabled> ${Lang.t('scheduler.day_tue')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="wed" disabled> ${Lang.t('scheduler.day_wed')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="thu" disabled> ${Lang.t('scheduler.day_thu')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="fri" disabled> ${Lang.t('scheduler.day_fri')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="sat" disabled> ${Lang.t('scheduler.day_sat')}</label>
                        <label style="font-size:12px;cursor:pointer;" class="hub-day-cb"><input type="checkbox" class="hub-day-check" value="sun" disabled> ${Lang.t('scheduler.day_sun')}</label>
                    </div>
                </div>
                <div id="hub-sched-msg" style="font-size:12px;margin-top:8px;"></div>
                <div style="text-align:right;margin-top:8px;"><button class="btn btn-sm btn-secondary" onclick="App._toggleScheduleForm()">✕ ${Lang.t('common.cancel')}</button></div>
            </div>`;

        if (allTasks.length === 0) {
            schedEl.innerHTML = `
                <div style="text-align:center;padding:20px;">
                    <div style="font-size:32px;margin-bottom:8px;">📅</div>
                    <div style="color:var(--text-muted);font-size:13px;">${Lang.t('scheduler.no_tasks')}</div>
                    <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="App._toggleScheduleForm()">➕ ${Lang.t('scheduler.create')}</button>
                </div>
                ${formHTML}`;
            // Initialiser les options du type en fonction de la cible
            setTimeout(() => this._onScheduleTargetChange(), 50);
            return;
        }

        const taskIcons = { restart: '🔄', backup: '💾', bot_start: '▶️', bot_stop: '⏹️', bot_restart: '🔄' };
        const taskLabels = {
            restart: Lang.t('scheduler.restart'), backup: Lang.t('scheduler.backup'),
            bot_start: Lang.t('scheduler.bot_start'), bot_stop: Lang.t('scheduler.bot_stop'),
            bot_restart: Lang.t('scheduler.bot_restart'),
        };

        schedEl.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <div style="font-size:13px;color:var(--text-muted);">${allTasks.length} ${Lang.t('scheduler.tasks_count')} ${servers.length + bots.length} ${Lang.t('scheduler.servers_count')}</div>
                <button class="btn btn-primary btn-sm" onclick="App._toggleScheduleForm()">➕ ${Lang.t('scheduler.new_task')}</button>
            </div>
            ${formHTML}
            <div style="display:flex;flex-direction:column;gap:6px;">
                ${allTasks.map(t => `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                        <span style="font-size:18px;">${taskIcons[t.task_type] || '📋'}</span>
                        <div style="flex:1;">
                            <div style="font-size:13px;font-weight:600;">${taskLabels[t.task_type] || t.task_type}</div>
                            <div style="font-size:11px;color:var(--text-muted);">${t.targetIcon} ${t.targetName} · ${t.schedule_time ? ('⏰ ' + Lang.t('scheduler.at') + ' ' + t.schedule_time + ' (' + (t.schedule_days || 'daily') + ')') : ('⏰ ' + Lang.t('scheduler.every') + ' ' + t.interval_hours + 'h')}</div>
                        </div>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${t.enabled !== false ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)'};color:${t.enabled !== false ? 'var(--accent-green)' : 'var(--text-muted)'};">${t.enabled !== false ? '● ' + Lang.t('scheduler.active') : '○ ' + Lang.t('scheduler.inactive')}</span>
                            <button class="btn btn-sm btn-secondary" onclick="App._toggleHubTask(${t.id})" title="${t.enabled ? 'Pause' : 'Resume'}">${t.enabled !== false ? '⏸' : '▶️'}</button>
                            <button class="btn btn-sm btn-danger" onclick="App._deleteHubTask(${t.id})" title="Delete">🗑️</button>
                        </div>
                    </div>
                `).join('')}
            </div>`;
        // Initialiser les options du type en fonction de la cible
        setTimeout(() => this._onScheduleTargetChange(), 50);
    },

    /**
     * Actualise la liste des types de tâches selon la cible sélectionnée (serveur ou bot).
     */
    _onScheduleTargetChange() {
        const targetEl = document.getElementById('hub-sched-target');
        const typeEl = document.getElementById('hub-sched-type');
        if (!targetEl || !typeEl) return;

        const val = targetEl.value || '';
        const isBot = val.startsWith('bot_');

        if (isBot) {
            typeEl.innerHTML = `
                <option value="bot_start">${Lang.t('scheduler.bot_start')}</option>
                <option value="bot_stop">${Lang.t('scheduler.bot_stop')}</option>
                <option value="bot_restart">${Lang.t('scheduler.bot_restart')}</option>`;
        } else {
            typeEl.innerHTML = `
                <option value="backup">💾 ${Lang.t('scheduler.backup')}</option>
                <option value="restart">🔄 ${Lang.t('scheduler.restart')}</option>`;
        }
    },

    _toggleScheduleForm() {
        const form = document.getElementById('hub-schedule-form');
        if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
    },

    _onScheduleModeChange() {
        const mode = document.getElementById('hub-sched-mode')?.value || 'interval';
        const intervalRow = document.getElementById('hub-sched-interval-row');
        const fixedRow = document.getElementById('hub-sched-fixed-row');
        if (intervalRow) intervalRow.style.display = mode === 'interval' ? 'flex' : 'none';
        if (fixedRow) fixedRow.style.display = mode === 'fixed' ? 'block' : 'none';
    },

    _onDailyToggle(cb) {
        const checks = document.querySelectorAll('.hub-day-check');
        checks.forEach(c => {
            c.disabled = cb.checked;
            if (cb.checked) c.checked = false;
        });
    },

    async _createScheduledTask() {
        const targetVal = document.getElementById('hub-sched-target')?.value;
        const taskType = document.getElementById('hub-sched-type')?.value;
        const interval = parseInt(document.getElementById('hub-sched-interval')?.value) || 6;
        const msg = document.getElementById('hub-sched-msg');

        if (!targetVal) { if (msg) { msg.style.color = '#ef4444'; msg.textContent = Lang.t('scheduler.select_target'); } return; }

        // Parser "server_3" ou "bot_5"
        const [targetType, targetId] = targetVal.split('_');
        const body = { task_type: taskType };
        if (targetType === 'server') body.server_id = parseInt(targetId);
        else if (targetType === 'bot') body.bot_id = parseInt(targetId);

        // Mode intervalle vs heure fixe
        const mode = document.getElementById('hub-sched-mode')?.value || 'interval';
        if (mode === 'fixed') {
            body.schedule_time = document.getElementById('hub-sched-time')?.value || '08:00';
            const dailyCb = document.getElementById('hub-day-daily');
            if (dailyCb && dailyCb.checked) {
                body.schedule_days = 'daily';
            } else {
                const checked = [...document.querySelectorAll('.hub-day-check:checked')].map(c => c.value);
                body.schedule_days = checked.length > 0 ? checked.join(',') : 'daily';
            }
        } else {
            body.interval_hours = parseInt(document.getElementById('hub-sched-interval')?.value) || 6;
        }

        const r = await Auth.apiCall('/api/scheduler/', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = '#22c55e'; msg.textContent = Lang.t('scheduler.created'); }
            setTimeout(() => this._loadGlobalSchedule(), 500);
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async _toggleHubTask(taskId) {
        await Auth.apiCall(`/api/scheduler/${taskId}/toggle`, { method: 'POST' });
        this._loadGlobalSchedule();
    },

    async _deleteHubTask(taskId) {
        if (!confirm(Lang.t('gs.delete_warn'))) return;
        await Auth.apiCall(`/api/scheduler/${taskId}`, { method: 'DELETE' });
        this._loadGlobalSchedule();
    },

    /**
     * Diagnostic auto — analyse la santé du système.
     */
    async runDiagnostic() {
        const panel = document.getElementById('diagnostic-panel');
        if (!panel) return;

        panel.style.display = 'block';
        panel.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);">${Lang.t('dashboard.analyzing')}</div>`;

        const r = await Auth.apiCall('/api/diagnostic');
        if (!r || !r.ok) {
            panel.innerHTML = `<div style="color:#ef4444;padding:12px;">${Lang.t('dashboard.diag_error')}</div>`;
            return;
        }
        const d = await r.json();

        const levelColors = { ok: '#22c55e', warning: '#f59e0b', critical: '#ef4444' };
        const levelIcons = { ok: '✅', warning: '⚠️', critical: '🔴' };
        const levelBg = { ok: 'rgba(34,197,94,0.08)', warning: 'rgba(245,158,11,0.08)', critical: 'rgba(239,68,68,0.08)' };
        const overallLabel = { ok: Lang.t('dashboard.all_good'), warning: Lang.t('dashboard.attention'), critical: Lang.t('dashboard.problems') };

        panel.innerHTML = `
            <div style="background:var(--bg-secondary);border-radius:12px;padding:20px;border:1px solid var(--border-color);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <div>
                        <div style="font-size:16px;font-weight:700;">${overallLabel[d.overall] || '🩺 Diagnostic'}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${d.ok} OK · ${d.warnings} ${Lang.t('dashboard.warnings')} · ${d.criticals} ${Lang.t('dashboard.criticals')}</div>
                    </div>
                    <button onclick="document.getElementById('diagnostic-panel').style.display='none'" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;">✕</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    ${d.checks.map(c => `
                        <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:${levelBg[c.level]};border-radius:8px;border:1px solid ${levelColors[c.level]}20;">
                            <span style="font-size:20px;">${c.icon}</span>
                            <div style="flex:1;min-width:0;">
                                <div style="display:flex;gap:8px;align-items:center;">
                                    <span style="font-weight:600;font-size:13px;">${c.name}</span>
                                    <span style="font-size:11px;color:${levelColors[c.level]};font-weight:600;">${levelIcons[c.level]} ${c.value}</span>
                                </div>
                                <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${c.message}</div>
                                ${c.suggestion ? `<div style="font-size:11px;color:${levelColors[c.level]};margin-top:4px;">💡 ${c.suggestion}</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
    },

    /**
     * Kill All — arrête tous les services d'urgence.
     */
    async killAllServers() {
        if (!confirm('⚠️ ARRÊT D\'URGENCE\n\nCela va arrêter TOUS les serveurs de jeux en cours.\n\nContinuer ?')) return;

        const r = await Auth.apiCall('/api/servers');
        if (!r || !r.ok) { if (typeof Toast !== 'undefined') Toast.error('Erreur'); return; }
        const servers = await r.json();

        let stopped = 0;
        for (const s of servers) {
            if (s.status === 'running') {
                const sr = await Auth.apiCall(`/api/servers/${s.id}/stop`, { method: 'POST' });
                if (sr && sr.ok) stopped++;
            }
        }

        if (typeof Toast !== 'undefined') Toast.success(`${stopped} serveur(s) arrêté(s)`);
        else alert(`✅ ${stopped} serveur(s) arrêté(s)`);
        if (this.currentView === 'hub') {
            this.navigateTo('hub');
        }
    },

    /**
     * Vue Settings (paramètres basiques pour V1).
     */
    renderSettings(content) {
        const user = Auth.getUser();
        const isAdmin = user && user.is_admin;
        const t = (k) => Lang.t(k);

        content.innerHTML = `
            <div class="page-header">
                <h1 class="page-title">${t('settings.title')}</h1>
                <p class="page-subtitle">${t('settings.subtitle')}</p>
            </div>

            <div style="display: flex; flex-direction: column; gap: 20px; max-width: 600px;">
                <div class="card">
                    <h3 class="card-title">${t('settings.account')}</h3>
                    <div style="margin-top: 12px;">
                        <p><strong>${t('settings.user_label')}</strong> ${user ? user.username : '—'}</p>
                        <p><strong>${t('settings.role_label')}</strong> ${isAdmin ? '👑 ' + t('common.admin') : '🎮'}</p>
                    </div>
                    <button class="btn btn-danger mt-4" onclick="Auth.logout()">
                        ${t('settings.logout')}
                    </button>
                </div>

                <div class="card">
                    <h3 class="card-title">${t('settings.change_password')}</h3>
                    <div style="margin-top: 16px;">
                        <div class="form-group">
                            <label class="form-label">${t('settings.current_password')}</label>
                            <input type="password" class="form-input" id="current-password" placeholder="••••••••" />
                        </div>
                        <div class="form-group">
                            <label class="form-label">${t('settings.new_password')}</label>
                            <input type="password" class="form-input" id="new-password" placeholder="••••••••" />
                        </div>
                        <div class="form-group">
                            <label class="form-label">${t('settings.confirm_password')}</label>
                            <input type="password" class="form-input" id="confirm-password" placeholder="••••••••" />
                        </div>
                        <div id="password-message" style="font-size: 13px; margin-bottom: 12px;"></div>
                        <button class="btn btn-primary" onclick="App.changePassword()">
                            ${t('settings.change_btn')}
                        </button>
                    </div>
                </div>

                ${isAdmin ? `
                <div class="card">
                    <div class="flex justify-between items-center">
                        <h3 class="card-title" style="margin: 0;">${t('settings.invitations')}</h3>
                        <button class="btn btn-primary btn-sm" onclick="App.createInvitation()">
                            ${t('settings.invite_create')}
                        </button>
                    </div>
                    <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
                        ${t('settings.invite_desc')}
                    </p>
                    <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <select class="form-input" id="invite-role" style="flex: 1;">
                            <option value="spectator">${t('settings.invite_spectator')}</option>
                            <option value="player" selected>${t('settings.invite_player')}</option>
                            <option value="money">${t('settings.invite_money')}</option>
                            <option value="moderator">${t('settings.invite_mod')}</option>
                            <option value="developer">${t('settings.invite_dev')}</option>
                        </select>
                    </div>
                    <div id="invite-result" style="margin-top: 12px;"></div>
                    <div id="invitations-list" style="margin-top: 16px;">
                        <div style="text-align: center; padding: 16px; color: var(--text-muted); font-size: 13px;">${t('common.loading')}</div>
                    </div>
                </div>
                <div class="card">
                    <h3 class="card-title">${t('settings.users')}</h3>
                    <div id="users-list" style="margin-top: 12px;">
                        <div style="text-align: center; padding: 16px; color: var(--text-muted); font-size: 13px;">${t('common.loading')}</div>
                    </div>
                </div>
                ` : ''}

                <div class="card">
                    <h3 class="card-title">${t('settings.language')}</h3>
                    <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${t('settings.lang_desc')}</p>
                    <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <button class="btn ${Lang.current === 'fr' ? 'btn-primary' : 'btn-secondary'}" onclick="Lang.set('fr')" style="flex:1;">🇫🇷 Français</button>
                        <button class="btn ${Lang.current === 'en' ? 'btn-primary' : 'btn-secondary'}" onclick="Lang.set('en')" style="flex:1;">🇬🇧 English</button>
                        <button class="btn ${Lang.current === 'it' ? 'btn-primary' : 'btn-secondary'}" onclick="Lang.set('it')" style="flex:1;">🇮🇹 Italiano</button>
                    </div>
                </div>

                ${isAdmin ? `
                <div class="card" id="power-schedule-card">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div>
                            <h3 class="card-title" style="margin:0;">${t('power.title')}</h3>
                            <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${t('power.desc')}</p>
                        </div>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                            <span id="power-status-label" style="font-size:12px;color:var(--text-muted);">--</span>
                            <input type="checkbox" id="power-enabled" onchange="App._onPowerToggle()" style="width:18px;height:18px;cursor:pointer;" />
                        </label>
                    </div>
                    <div id="power-config" style="margin-top:16px;">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                            <div>
                                <label class="form-label">⏻ ${t('power.shutdown_time')}</label>
                                <input type="time" id="power-shutdown-hour" class="form-input" value="01:00" />
                            </div>
                            <div>
                                <label class="form-label">⏰ ${t('power.wake_time')}</label>
                                <input type="time" id="power-wake-hour" class="form-input" value="05:00" />
                            </div>
                        </div>
                        <div style="margin-top:12px;padding:10px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                            <div style="font-size:12px;color:var(--text-muted);">💡 ${t('power.graceful_info')}</div>
                        </div>
                        <div id="power-rtcwake-warn" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:12px;color:#f59e0b;">
                            ⚠️ rtcwake non détecté — le réveil automatique ne fonctionnera pas. Installez util-linux.
                        </div>
                        <div id="power-last-info" style="margin-top:12px;font-size:12px;color:var(--text-muted);"></div>
                        <div style="display:flex;gap:8px;margin-top:16px;align-items:center;">
                            <button class="btn btn-primary" onclick="App._savePowerSchedule()">${t('power.save')}</button>
                            <button class="btn btn-secondary" onclick="App._testPower()" title="${t('power.test_desc')}">${t('power.test')}</button>
                            <button class="btn btn-secondary" onclick="App._cancelPowerWake()" style="font-size:12px;">${t('power.cancel')}</button>
                            <span id="power-msg" style="font-size:12px;margin-left:8px;"></span>
                        </div>
                    </div>
                </div>
                ` : ''}

                ${isAdmin ? `
                <div class="card">
                    <h3 class="card-title" style="margin:0;">${t('nodes.api_key')}</h3>
                    <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${t('nodes.api_key_desc')}</p>
                    <div style="display:flex;gap:8px;margin-top:12px;align-items:center;">
                        <code id="nodes-api-key" style="flex:1;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;font-size:12px;word-break:break-all;color:var(--text-primary);">Chargement...</code>
                        <button class="btn btn-secondary btn-sm" onclick="App._copyNodesKey()" title="${t('nodes.copy')}">📋</button>
                        <button class="btn btn-secondary btn-sm" onclick="App._resetNodesKey()" style="font-size:11px;">${t('nodes.reset_key')}</button>
                    </div>
                </div>
                ` : ''}
            </div>
        `;



        // Charger les listes si admin
        if (isAdmin) {
            this.loadInvitations();
            this._loadUsersAdmin();
            this._loadPowerSchedule();
            this._loadNodesKey();
        }
    },

    // --- Changement de mot de passe ---

    async changePassword() {
        const current = document.getElementById('current-password').value;
        const newPwd = document.getElementById('new-password').value;
        const confirm = document.getElementById('confirm-password').value;
        const msgEl = document.getElementById('password-message');

        if (!current || !newPwd || !confirm) {
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = Lang.t('settings.fill_all');
            return;
        }
        if (newPwd !== confirm) {
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = Lang.t('settings.pwd_mismatch');
            return;
        }
        if (newPwd.length < 4) {
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = Lang.t('settings.pwd_min');
            return;
        }

        msgEl.style.color = 'var(--text-muted)';
        msgEl.textContent = Lang.t('settings.pwd_changing');

        const response = await Auth.apiCall('/api/auth/change-password', {
            method: 'PUT',
            body: JSON.stringify({ current_password: current, new_password: newPwd }),
        });

        if (response && response.ok) {
            msgEl.style.color = '#2ecc71';
            msgEl.textContent = Lang.t('settings.pwd_success');
            document.getElementById('current-password').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
        } else if (response) {
            const err = await response.json();
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = `❌ ${err.detail || Lang.t('common.error')}`;
        }
    },

    // --- Invitations ---

    async createInvitation() {
        const role = document.getElementById('invite-role').value;
        const resultEl = document.getElementById('invite-result');

        const response = await Auth.apiCall('/api/auth/invitations', {
            method: 'POST',
            body: JSON.stringify({ role, max_uses: 1 }),
        });

        if (response && response.ok) {
            const data = await response.json();
            const link = `${location.origin}/login?invite=${data.code}`;
            resultEl.innerHTML = `
                <div style="background: var(--bg-hover); border-radius: 8px; padding: 12px; border: 1px solid var(--accent-green);">
                    <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">🔗 Lien d'invitation (${data.role_name})</div>
                    <div style="font-family: monospace; font-size: 14px; color: var(--accent-green); word-break: break-all;">${link}</div>
                    <button class="btn btn-secondary btn-sm mt-4" onclick="navigator.clipboard.writeText('${link}').then(() => this.textContent = '✅ Copié !')">
                        📋 Copier le lien
                    </button>
                </div>
            `;
            this.loadInvitations();
        }
    },

    async loadInvitations() {
        const listEl = document.getElementById('invitations-list');
        if (!listEl) return;

        const response = await Auth.apiCall('/api/auth/invitations');
        if (!response) return;
        const data = await response.json();
        const invites = data.invitations || [];

        if (invites.length === 0) {
            listEl.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--text-muted); font-size: 13px;">Aucune invitation</div>';
            return;
        }

        listEl.innerHTML = invites.map(inv => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-color); font-size: 13px;">
                <div>
                    <span style="font-family: monospace; color: var(--accent-blue);">${inv.code}</span>
                    <span style="color: var(--text-muted);"> · ${inv.role_name}</span>
                    <span style="color: ${inv.is_used ? '#e74c3c' : 'var(--accent-green)'};">
                        ${inv.is_used ? ' · Utilisé' : ' · Actif'}
                    </span>
                </div>
                <button class="btn btn-danger btn-sm" onclick="App.deleteInvitation(${inv.id})" style="padding: 2px 8px; font-size: 11px;">✕</button>
            </div>
        `).join('');
    },

    async deleteInvitation(id) {
        const response = await Auth.apiCall(`/api/auth/invitations/${id}`, { method: 'DELETE' });
        if (response && response.ok) this.loadInvitations();
    },

    // --- Power Schedule (extinction/réveil automatique) ---

    async _loadPowerSchedule() {
        const r = await Auth.apiCall('/api/power/schedule');
        if (!r || !r.ok) return;
        const config = await r.json();

        const enabledCb = document.getElementById('power-enabled');
        const shutdownInput = document.getElementById('power-shutdown-hour');
        const wakeInput = document.getElementById('power-wake-hour');
        const statusLabel = document.getElementById('power-status-label');
        const configDiv = document.getElementById('power-config');
        const lastInfo = document.getElementById('power-last-info');

        if (enabledCb) enabledCb.checked = config.enabled;
        if (shutdownInput) shutdownInput.value = config.shutdown_hour || '01:00';
        if (wakeInput) wakeInput.value = config.wake_hour || '05:00';

        if (statusLabel) {
            statusLabel.textContent = config.enabled ? Lang.t('power.enabled') : Lang.t('power.disabled');
            statusLabel.style.color = config.enabled ? 'var(--accent-green)' : 'var(--text-muted)';
        }

        if (configDiv) {
            configDiv.style.opacity = config.enabled ? '1' : '0.5';
        }

        // Info dernière extinction
        if (lastInfo) {
            let html = '';
            if (config.enabled) {
                html += `<span style="color:var(--accent-green);">● ${Lang.t('power.next_shutdown')}: ${Lang.t('power.tonight')} ${config.shutdown_hour}</span>`;
            }
            if (config.last_shutdown) {
                const d = new Date(config.last_shutdown);
                html += ` · ${Lang.t('power.last_shutdown')}: ${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0,5)} ✅`;
            } else {
                html += ` · ${Lang.t('power.last_shutdown')}: ${Lang.t('power.never')}`;
            }
            lastInfo.innerHTML = html;
        }

        // Avertissement si rtcwake non disponible
        if (config.rtcwake_available === false) {
            const warn = document.getElementById('power-rtcwake-warn');
            if (warn) warn.style.display = 'block';
        }
    },

    _onPowerToggle() {
        const enabled = document.getElementById('power-enabled')?.checked;
        const statusLabel = document.getElementById('power-status-label');
        const configDiv = document.getElementById('power-config');

        if (statusLabel) {
            statusLabel.textContent = enabled ? Lang.t('power.enabled') : Lang.t('power.disabled');
            statusLabel.style.color = enabled ? 'var(--accent-green)' : 'var(--text-muted)';
        }
        if (configDiv) {
            configDiv.style.opacity = enabled ? '1' : '0.5';
        }
    },

    async _savePowerSchedule() {
        const msg = document.getElementById('power-msg');
        const body = {
            enabled: document.getElementById('power-enabled')?.checked || false,
            shutdown_hour: document.getElementById('power-shutdown-hour')?.value || '01:00',
            wake_hour: document.getElementById('power-wake-hour')?.value || '05:00',
        };

        const r = await Auth.apiCall('/api/power/schedule', {
            method: 'PUT',
            body: JSON.stringify(body),
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = Lang.t('power.saved'); }
            if (typeof Toast !== 'undefined') Toast.success(Lang.t('power.saved'));
            // Recharger pour mettre à jour les infos
            setTimeout(() => this._loadPowerSchedule(), 500);
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async _testPower() {
        if (!confirm(Lang.t('power.test_desc') + '\n\nContinuer ?')) return;

        const msg = document.getElementById('power-msg');
        const r = await Auth.apiCall('/api/power/test', { method: 'POST' });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = Lang.t('power.test_launched'); }
            if (typeof Toast !== 'undefined') Toast.info(Lang.t('power.test_launched'));
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async _cancelPowerWake() {
        const msg = document.getElementById('power-msg');
        const r = await Auth.apiCall('/api/power/cancel', { method: 'POST' });

        if (r && r.ok) {
            const data = await r.json();
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = data.message; }
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    // --- Nodes API Key ---

    async _loadNodesKey() {
        const r = await Auth.apiCall('/api/nodes/key');
        if (!r || !r.ok) return;
        const data = await r.json();
        const el = document.getElementById('nodes-api-key');
        if (el) el.textContent = data.key;
    },

    async _copyNodesKey() {
        const el = document.getElementById('nodes-api-key');
        if (!el) return;
        try {
            await navigator.clipboard.writeText(el.textContent);
            if (typeof Toast !== 'undefined') Toast.success(Lang.t('nodes.copied'));
        } catch (e) {
            // Fallback
            const range = document.createRange();
            range.selectNode(el);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.execCommand('copy');
            if (typeof Toast !== 'undefined') Toast.success(Lang.t('nodes.copied'));
        }
    },

    async _resetNodesKey() {
        if (!confirm(Lang.t('nodes.reset_confirm'))) return;
        const r = await Auth.apiCall('/api/nodes/key/reset', { method: 'POST' });
        if (r && r.ok) {
            const data = await r.json();
            const el = document.getElementById('nodes-api-key');
            if (el) el.textContent = data.key;
            if (typeof Toast !== 'undefined') Toast.warn(data.message);
        }
    },

    // --- Gestion des utilisateurs ---

    renderUsers(content) {
        content.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <div>
                <h1 style="margin:0;">${Lang.t('users.title')}</h1>
                <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">${Lang.t('users.subtitle')}</p>
            </div>
            <button class="btn btn-secondary" onclick="App.navigateTo('hub')">${Lang.t('users.back_hub')}</button>
        </div>

        <!-- Créer un utilisateur -->
        <div class="card" style="margin-bottom:20px;">
            <h3 style="margin:0 0 16px;">${Lang.t('users.create_title')}</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end;">
                <div>
                    <label class="form-label">${Lang.t('users.username')}</label>
                    <input id="new-user-name" class="form-input" placeholder="${Lang.t('users.username_hint')}" />
                </div>
                <div>
                    <label class="form-label">${Lang.t('users.password')}</label>
                    <input id="new-user-pass" class="form-input" type="password" placeholder="${Lang.t('users.password_hint')}" />
                </div>
                <div>
                    <label class="form-label">${Lang.t('users.role')}</label>
                    <select id="new-user-role" class="form-input">
                        <option value="spectator">${Lang.t('users.role_spectator')}</option>
                        <option value="player" selected>${Lang.t('users.role_player')}</option>
                        <option value="money">${Lang.t('users.role_money')}</option>
                        <option value="moderator">${Lang.t('users.role_moderator')}</option>
                        <option value="developer">${Lang.t('users.role_developer')}</option>
                        <option value="admin">${Lang.t('users.role_admin')}</option>
                    </select>
                </div>
                <button class="btn btn-primary" onclick="App.createUser()" style="height:38px;">${Lang.t('users.create_btn')}</button>
            </div>
            <div id="create-user-msg" style="font-size:13px;margin-top:8px;"></div>
        </div>

        <!-- Liste des utilisateurs -->
        <div class="card">
            <h3 style="margin:0 0 16px;">${Lang.t('users.list_title')}</h3>
            <div id="users-admin-list"><div style="text-align:center;padding:20px;color:var(--text-muted);">${Lang.t('users.loading')}</div></div>
        </div>
        `;
        this._loadUsersAdmin();
    },

    async createUser() {
        const name = document.getElementById('new-user-name')?.value?.trim();
        const pass = document.getElementById('new-user-pass')?.value;
        const role = document.getElementById('new-user-role')?.value || 'player';
        const msg = document.getElementById('create-user-msg');
        if (!name || !pass) { if (msg) { msg.style.color = '#e74c3c'; msg.textContent = Lang.t('users.fill_fields'); } return; }
        if (pass.length < 4) { if (msg) { msg.style.color = '#e74c3c'; msg.textContent = Lang.t('users.pass_too_short'); } return; }

        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = Lang.t('users.creating'); }
        const r = await Auth.apiCall('/api/auth/admin/create-user', {
            method: 'POST', body: JSON.stringify({ username: name, password: pass, is_admin: role === 'admin' })
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = Lang.t('users.created'); }
            document.getElementById('new-user-name').value = '';
            document.getElementById('new-user-pass').value = '';
            // Si le r\u00f4le n'est pas admin, on doit aussi changer le r\u00f4le
            if (role !== 'admin' && role !== 'player') {
                const data = await r.json();
                await Auth.apiCall(`/api/auth/admin/users/${data.id}/role`, {
                    method: 'PUT', body: JSON.stringify({ role })
                });
            }
            this._loadUsersAdmin();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `\u274c ${err.detail || 'Erreur'}`; }
        }
    },

    async _loadUsersAdmin() {
        const listEl = document.getElementById('users-admin-list') || document.getElementById('users-list');
        if (!listEl) return;

        const response = await Auth.apiCall('/api/auth/admin/users');
        if (!response || !response.ok) { listEl.innerHTML = '<div style="color:#ef4444;">❌ ' + Lang.t('common.error') + '</div>'; return; }
        const users = await response.json();
        const currentUser = Auth.getUser();

        const roleLabels = { admin: Lang.t('users.role_admin'), moderator: Lang.t('users.role_moderator'), developer: Lang.t('users.role_developer'), money: Lang.t('users.role_money'), player: Lang.t('users.role_player'), spectator: Lang.t('users.role_spectator') };
        const permLabels = {
            view: Lang.t('users.perm_view'), start: Lang.t('users.perm_start'), stop: Lang.t('users.perm_stop'),
            restart: Lang.t('users.perm_restart'), console: Lang.t('users.perm_console'), backup: Lang.t('users.perm_backup'),
            logs: Lang.t('users.perm_logs'), create_server: Lang.t('users.perm_create_server'), create_bot: Lang.t('users.perm_create_bot'),
            delete: Lang.t('users.perm_delete'), settings: Lang.t('users.perm_settings'), invite: Lang.t('users.perm_invite'),
            manage_users: Lang.t('users.perm_manage_users'), yield_bot: Lang.t('users.perm_yield_bot'),
        };
        const rolePerms = {
            spectator: ['view'],
            player: ['view','start'],
            money: ['view','start','yield_bot'],
            moderator: ['view','start','stop','restart','console','backup','logs','create_server','delete','invite'],
            developer: ['view','start','stop','restart','console','backup','logs','create_server','create_bot','delete','invite'],
            admin: Object.keys(permLabels)
        };

        const allModules = [
            { id: 'game_server', icon: '🎮', label: Lang.t('users.mod_games') },
            { id: 'bots', icon: '🤖', label: Lang.t('users.mod_bots') },
            { id: 'files', icon: '📁', label: Lang.t('users.mod_files') },
            { id: 'media', icon: '📺', label: Lang.t('users.mod_media') },
            { id: 'web', icon: '🌐', label: Lang.t('users.mod_web') },
            { id: 'network', icon: '📡', label: Lang.t('users.mod_network') },
        ];

        listEl.innerHTML = users.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text-muted);">' + Lang.t('users.none') + '</div>' :
            users.map(u => {
                const userPerms = rolePerms[u.role] || [];
                const userModules = u.allowed_modules;
                const permBadges = Object.entries(permLabels).map(function([k, label]) {
                    const has = userPerms.includes(k);
                    return '<span style="font-size:10px;padding:2px 6px;border-radius:4px;'
                        + 'background:' + (has ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)') + ';'
                        + 'color:' + (has ? 'var(--accent-green)' : 'rgba(255,255,255,0.15)') + ';'
                        + 'border:1px solid ' + (has ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.05)') + ';">'
                        + label + '</span>';
                }).join('');
                const moduleBadges = allModules.map(function(m) {
                    const hasAccess = userModules === null || userModules.includes(m.id);
                    return '<span data-module="' + m.id + '" data-user="' + u.id + '"'
                        + ' onclick="event.stopPropagation();App._toggleUserModule(' + u.id + ', \'' + m.id + '\', this)"'
                        + ' style="font-size:11px;padding:3px 8px;border-radius:5px;cursor:pointer;user-select:none;transition:all .15s;'
                        + 'background:' + (hasAccess ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.04)') + ';'
                        + 'color:' + (hasAccess ? 'var(--accent-blue)' : 'rgba(255,255,255,0.2)') + ';'
                        + 'border:1px solid ' + (hasAccess ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.06)') + ';">'
                        + (hasAccess ? '☑' : '☐') + ' ' + m.icon + ' ' + m.label + '</span>';
                }).join('');

                return '<div style="padding:12px 0;border-bottom:1px solid var(--border-color);">'
                + '<div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;" onclick="App._toggleUserDetails(' + u.id + ')">'
                +   '<div style="display:flex;align-items:center;gap:12px;">'
                +     '<div style="width:36px;height:36px;border-radius:50%;background:' + (u.is_admin ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : 'var(--bg-secondary)') + ';display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:' + (u.is_admin ? 'white' : 'var(--text-muted)') + '">' + u.username.charAt(0).toUpperCase() + '</div>'
                +     '<div>'
                +       '<div style="font-weight:600;font-size:14px;">' + u.username + '</div>'
                +       '<div style="font-size:12px;color:var(--text-muted);">' + (roleLabels[u.role] || u.role) + (u.created_at ? ' · ' + Lang.t('users.created_on') + ' ' + new Date(u.created_at).toLocaleDateString() : '') + '</div>'
                +     '</div>'
                +   '</div>'
                +   '<div style="display:flex;align-items:center;gap:8px;">'
                +     (u.id !== currentUser?.id
                        ? '<select class="form-input" style="font-size:12px;padding:4px 8px;width:auto;" onchange="event.stopPropagation();App._changeRoleAdmin(' + u.id + ', this.value)" onclick="event.stopPropagation()">'
                        +   '<option value="spectator"' + (u.role === 'spectator' ? ' selected' : '') + '>' + Lang.t('users.role_spectator') + '</option>'
                        +   '<option value="player"' + (u.role === 'player' ? ' selected' : '') + '>' + Lang.t('users.role_player') + '</option>'
                        +   '<option value="money"' + (u.role === 'money' ? ' selected' : '') + '>' + Lang.t('users.role_money') + '</option>'
                        +   '<option value="moderator"' + (u.role === 'moderator' ? ' selected' : '') + '>' + Lang.t('users.role_moderator') + '</option>'
                        +   '<option value="developer"' + (u.role === 'developer' ? ' selected' : '') + '>' + Lang.t('users.role_developer') + '</option>'
                        +   '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>' + Lang.t('users.role_admin') + '</option>'
                        + '</select>'
                        + '<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();App._confirmDeleteUser(' + u.id + ', \'' + u.username + '\')" style="padding:4px 8px;font-size:12px;">🗑️</button>'
                        : '<span style="font-size:12px;color:var(--accent-green);font-weight:600;">' + Lang.t('users.you') + '</span>')
                +     '<span id="user-chevron-' + u.id + '" style="font-size:10px;color:var(--text-muted);transition:transform .2s;">▼</span>'
                +   '</div>'
                + '</div>'
                // Collapsible details
                + '<div id="user-details-' + u.id + '" style="display:none;">'
                +   '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px;padding-left:48px;">' + permBadges + '</div>'
                +   (u.id !== currentUser?.id && u.role !== 'admin'
                    ? '<div style="margin-top:8px;padding-left:48px;">'
                    +   '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">' + Lang.t('users.modules_allowed') + '</div>'
                    +   '<div style="display:flex;flex-wrap:wrap;gap:4px;" id="user-modules-' + u.id + '">' + moduleBadges + '</div>'
                    + '</div>'
                    : (u.role === 'admin' && u.id !== currentUser?.id
                        ? '<div style="margin-top:8px;padding-left:48px;"><div style="font-size:11px;color:var(--text-muted);">🧩 Modules : <span style="color:var(--accent-green);">' + Lang.t('users.modules_full') + '</span></div></div>'
                        : ''))
                + '</div>'
                + '</div>'
                + '<div id="del-confirm-' + u.id + '" style="display:none;background:rgba(239,68,68,0.08);border:1px solid #ef4444;border-radius:8px;padding:10px;margin:4px 0 8px;">'
                +   '<span style="font-size:12px;color:#ef4444;">' + Lang.t('users.delete_confirm').replace('${name}', u.username) + '</span>'
                +   '<button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'del-confirm-' + u.id + '\').style.display=\'none\'" style="margin-left:8px;font-size:11px;">' + Lang.t('common.cancel') + '</button>'
                +   '<button class="btn btn-sm" style="background:#ef4444;color:white;margin-left:4px;font-size:11px;" onclick="App._deleteUserAdmin(' + u.id + ')">' + Lang.t('users.delete_btn') + '</button>'
                + '</div>';
            }).join('');
    },

    _toggleUserDetails(userId) {
        const details = document.getElementById('user-details-' + userId);
        const chevron = document.getElementById('user-chevron-' + userId);
        if (!details) return;
        const isOpen = details.style.display !== 'none';
        details.style.display = isOpen ? 'none' : 'block';
        if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
    },

    async _toggleUserModule(userId, moduleId, el) {
        // Lire l'état actuel depuis tous les badges de cet utilisateur
        const container = document.getElementById(`user-modules-${userId}`);
        if (!container) return;

        const badges = container.querySelectorAll('[data-module]');
        const currentModules = [];
        let allEnabled = true;

        badges.forEach(badge => {
            const mid = badge.dataset.module;
            const isActive = badge.textContent.includes('☑');
            if (mid === moduleId) {
                // Toggle celui qu'on clique
                if (!isActive) currentModules.push(mid);
                // Si on désactive, on ne l'ajoute pas
            } else {
                if (isActive) currentModules.push(mid);
            }
        });

        // Si tous les modules sont activés, envoyer null (= tous)
        const allModuleIds = ['game_server', 'bots', 'files', 'media', 'web', 'network'];
        const payload = currentModules.length === allModuleIds.length ? null : currentModules;

        // Feedback visuel immédiat
        const isNowActive = el.textContent.includes('☐'); // était inactif, va devenir actif
        const moduleIcon = el.textContent.split(' ').slice(1).join(' ');
        if (isNowActive) {
            el.style.background = 'rgba(59,130,246,0.15)';
            el.style.color = 'var(--accent-blue)';
            el.style.borderColor = 'rgba(59,130,246,0.3)';
            el.textContent = '☑ ' + moduleIcon;
        } else {
            el.style.background = 'rgba(255,255,255,0.04)';
            el.style.color = 'rgba(255,255,255,0.2)';
            el.style.borderColor = 'rgba(255,255,255,0.06)';
            el.textContent = '☐ ' + moduleIcon;
        }

        // Appel API
        const r = await Auth.apiCall(`/api/auth/admin/users/${userId}/modules`, {
            method: 'PUT',
            body: JSON.stringify({ allowed_modules: payload })
        });

        if (!r || !r.ok) {
            // Rollback visuel
            if (typeof Toast !== 'undefined') Toast.error(Lang.t('users.update_error'));
            this._loadUsersAdmin();
        }
    },

    async _changeRoleAdmin(userId, role) {
        const r = await Auth.apiCall(`/api/auth/admin/users/${userId}/role`, {
            method: 'PUT', body: JSON.stringify({ role })
        });
        if (r && r.ok) this._loadUsersAdmin();
    },

    _confirmDeleteUser(userId, username) {
        document.getElementById(`del-confirm-${userId}`).style.display = 'block';
    },

    async _deleteUserAdmin(userId) {
        const r = await Auth.apiCall(`/api/auth/admin/users/${userId}`, { method: 'DELETE' });
        if (r && r.ok) this._loadUsersAdmin();
    },

};

// Lancer l'app quand la page est charg\u00e9e
document.addEventListener('DOMContentLoaded', () => App.init());

// ═══════════════════════════════════════════════
//  SharingModal — Modale de partage de ressources
// ═══════════════════════════════════════════════

const SharingModal = {
    _resourceType: null,
    _resourceId: null,
    _searchTimeout: null,
    _selectedUserId: null,

    open(resourceId, resourceType) {
        this._resourceId = resourceId;
        this._resourceType = resourceType;
        this._selectedUserId = null;

        const overlay = document.createElement('div');
        overlay.id = 'sharing-overlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal sharing-modal">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                    <h3 style="margin:0;">👥 ${Lang.t('sharing.title')}</h3>
                    <button class="btn btn-secondary btn-sm" onclick="SharingModal.close()" style="padding:4px 10px;">✕</button>
                </div>
                <div class="sharing-search-wrap">
                    <input id="sharing-search-input" class="form-input"
                        placeholder="${Lang.t('sharing.search_placeholder')}"
                        oninput="SharingModal._onSearch(this.value)"
                        autocomplete="off" />
                </div>
                <div id="sharing-search-results"></div>
                <div id="sharing-grant-form" style="display:none;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:8px;padding:12px;margin-bottom:16px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;">
                        <div class="sharing-user-info">
                            <div class="sharing-user-avatar" id="sharing-grant-avatar"></div>
                            <span id="sharing-grant-username" style="font-weight:600;font-size:13px;"></span>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <select id="sharing-grant-level" class="sharing-access-select">
                                <option value="view_only">${Lang.t('sharing.view_only')}</option>
                                <option value="start" selected>${Lang.t('sharing.start')}</option>
                                <option value="manage">${Lang.t('sharing.manage')}</option>
                            </select>
                            <button class="btn btn-primary btn-sm" onclick="SharingModal._grantAccess()">${Lang.t('sharing.grant')}</button>
                        </div>
                    </div>
                </div>
                <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;">${Lang.t('sharing.access_level')}</div>
                <div id="sharing-access-list">
                    <div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px;">⏳</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('active'));
        this._loadAccessList();
        setTimeout(() => document.getElementById('sharing-search-input')?.focus(), 200);
    },

    close() {
        const overlay = document.getElementById('sharing-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 200);
        }
    },

    _onSearch(query) {
        clearTimeout(this._searchTimeout);
        if (query.length < 1) {
            document.getElementById('sharing-search-results').innerHTML = '';
            document.getElementById('sharing-grant-form').style.display = 'none';
            return;
        }
        this._searchTimeout = setTimeout(() => this._searchUsers(query), 300);
    },

    async _searchUsers(query) {
        const r = await Auth.apiCall(`/api/sharing/users/search?q=${encodeURIComponent(query)}`);
        const el = document.getElementById('sharing-search-results');
        if (!r || !r.ok || !el) return;
        const users = await r.json();
        if (users.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:12px;">—</div>';
            return;
        }
        el.innerHTML = users.map(u => `
            <div class="sharing-user-item" onclick="SharingModal._selectUser(${u.id}, '${u.username.replace(/'/g, "\\\\'")}', '${u.role}')" style="cursor:pointer;">
                <div class="sharing-user-info">
                    <div class="sharing-user-avatar">${u.username.charAt(0).toUpperCase()}</div>
                    <div>
                        <div style="font-weight:600;font-size:13px;">${u.username}</div>
                        <span class="role-badge ${u.role}">${Lang.t('users.role_' + u.role) || u.role}</span>
                    </div>
                </div>
            </div>
        `).join('');
    },

    _selectUser(userId, username) {
        this._selectedUserId = userId;
        document.getElementById('sharing-search-results').innerHTML = '';
        document.getElementById('sharing-search-input').value = username;
        const form = document.getElementById('sharing-grant-form');
        form.style.display = 'block';
        document.getElementById('sharing-grant-avatar').textContent = username.charAt(0).toUpperCase();
        document.getElementById('sharing-grant-username').textContent = username;
    },

    async _grantAccess() {
        if (!this._selectedUserId) return;
        const level = document.getElementById('sharing-grant-level').value;
        const username = document.getElementById('sharing-grant-username').textContent;
        const r = await Auth.apiCall('/api/sharing/grant', {
            method: 'POST',
            body: JSON.stringify({
                resource_type: this._resourceType,
                resource_id: this._resourceId,
                username: username,
                access_level: level,
            })
        });
        if (r && r.ok) {
            Toast.success(username + ' \u2192 ' + level);
            document.getElementById('sharing-grant-form').style.display = 'none';
            document.getElementById('sharing-search-input').value = '';
            this._selectedUserId = null;
            this._loadAccessList();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            Toast.error(err.detail || Lang.t('common.error'));
        }
    },

    async _loadAccessList() {
        const el = document.getElementById('sharing-access-list');
        if (!el) return;
        const r = await Auth.apiCall(`/api/sharing/resource/${this._resourceType}/${this._resourceId}`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#ef4444;font-size:12px;">Error</div>'; return; }
        const accesses = await r.json();
        if (accesses.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">${Lang.t('sharing.no_access')}</div>`;
            return;
        }
        const ll = { view_only: Lang.t('sharing.view_only'), start: Lang.t('sharing.start'), manage: Lang.t('sharing.manage') };
        el.innerHTML = accesses.map(a => `
            <div class="sharing-user-item" style="margin-bottom:6px;">
                <div class="sharing-user-info">
                    <div class="sharing-user-avatar">${(a.username||'?').charAt(0).toUpperCase()}</div>
                    <div>
                        <div style="font-weight:600;font-size:13px;">${a.username}</div>
                        <div style="font-size:10px;color:var(--text-muted);">${Lang.t('sharing.granted_by')} ${a.granted_by}</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <select class="sharing-access-select" onchange="SharingModal._updateAccess(${a.id}, this.value)">
                        <option value="view_only" ${a.access_level==='view_only'?'selected':''}>${ll.view_only}</option>
                        <option value="start" ${a.access_level==='start'?'selected':''}>${ll.start}</option>
                        <option value="manage" ${a.access_level==='manage'?'selected':''}>${ll.manage}</option>
                    </select>
                    <button class="btn btn-sm" style="color:#ef4444;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);padding:4px 8px;font-size:11px;" onclick="SharingModal._revokeAccess(${a.id}, '${(a.username||'').replace(/'/g,"\\\\'")}')">${Lang.t('sharing.revoke')}</button>
                </div>
            </div>
        `).join('');
    },

    async _updateAccess(accessId, newLevel) {
        const r = await Auth.apiCall(`/api/sharing/${accessId}`, { method: 'PUT', body: JSON.stringify({ access_level: newLevel }) });
        if (r && r.ok) Toast.success('OK');
        else { Toast.error(Lang.t('common.error')); this._loadAccessList(); }
    },

    async _revokeAccess(accessId, username) {
        const r = await Auth.apiCall(`/api/sharing/${accessId}`, { method: 'DELETE' });
        if (r && r.ok) { Toast.success(Lang.t('sharing.revoke') + ' \u2190 ' + username); this._loadAccessList(); }
        else Toast.error(Lang.t('common.error'));
    },
};

