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

        // Charger le hub par défaut
        await this.navigateTo('hub');

        // Démarrer le monitoring
        Monitoring.start();

        // Charger le thème sauvegardé
        this._loadTheme();
    },

    // === THÈMES ===
    _themes: ['default', 'midnight', 'emerald', 'crimson'],
    _themeNames: { default: '🌑 Défaut', midnight: '🌊 Midnight', emerald: '🌲 Emerald', crimson: '🔥 Crimson' },

    _loadTheme() {
        const saved = localStorage.getItem('omen-theme') || 'default';
        document.documentElement.setAttribute('data-theme', saved);
    },

    cycleTheme() {
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
        if (roleEl) roleEl.textContent = user.is_admin ? 'Administrateur' : 'Utilisateur';

        // Afficher le lien Utilisateurs seulement pour les admins
        const navUsers = document.getElementById('nav-users');
        if (navUsers) navUsers.style.display = user.is_admin ? '' : 'none';
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

        // Mettre à jour la sidebar
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view || (view === 'server_view' && item.dataset.view === 'game_server'));
        });

        const content = document.getElementById('module-content');
        if (!content) return;

        // Supprimer le padding pour la vue serveur (sidebar doit coller au bord)
        content.classList.toggle('sv-fullscreen', view === 'server_view');

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
                        <p>Ce module n'est pas encore disponible.</p>
                        <button class="btn btn-secondary mt-4" onclick="App.navigateTo('hub')">← Retour au Hub</button>
                    </div>
                `;
        }
    },

    /**
     * Affiche la vue Hub avec le monitoring + les modules.
     */
    renderHub(content) {
        content.innerHTML = `
            <div class="page-header">
                <h1 class="page-title">Dashboard</h1>
                <p class="page-subtitle">Vue d'ensemble de ton serveur</p>
            </div>

            <!-- Stats monitoring -->
            <div class="stats-grid">
                <div class="stat-card" style="--stat-color: var(--accent-green)">
                    <div class="stat-label">CPU</div>
                    <div class="stat-value"><span id="stat-cpu-value">--</span><span class="stat-unit">%</span></div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-cpu-bar" style="width: 0%"></div></div>
                </div>
                <div class="stat-card" style="--stat-color: var(--accent-blue)">
                    <div class="stat-label">Mémoire RAM</div>
                    <div class="stat-value"><span id="stat-memory-value">--</span><span class="stat-unit">%</span></div>
                    <div id="stat-memory-detail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">-- / -- Go</div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-memory-bar" style="width: 0%"></div></div>
                </div>
                <div class="stat-card" style="--stat-color: var(--accent-purple)">
                    <div class="stat-label">Disque</div>
                    <div class="stat-value"><span id="stat-disk-value">--</span><span class="stat-unit">%</span></div>
                    <div id="stat-disk-detail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">-- / -- Go</div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-disk-bar" style="width: 0%"></div></div>
                </div>
                <div class="stat-card" style="--stat-color: var(--accent-yellow)">
                    <div class="stat-label">Température</div>
                    <div class="stat-value"><span id="stat-temp-value">--</span><span class="stat-unit">°C</span></div>
                    <div class="stat-bar"><div class="stat-bar-fill" id="stat-temp-bar" style="width: 0%"></div></div>
                </div>
            </div>

            <!-- Réseau -->
            <div style="margin-bottom: 28px; font-size: 13px; color: var(--text-muted);">
                🌐 Réseau : <span id="stat-network">--</span>
            </div>

            <!-- Kill All + Diagnostic -->
            <div style="display:flex;gap:12px;margin-bottom:28px;align-items:center;">
                <button class="btn btn-kill-all" onclick="App.killAllServers()" title="Arrêter tous les services d'urgence">
                    🔴 Kill All
                </button>
                <button class="btn btn-secondary" onclick="App.runDiagnostic()" id="diag-btn" style="display:flex;align-items:center;gap:6px;">
                    🩺 Diagnostic
                </button>
                <span style="font-size:12px;color:var(--text-muted);">Actions rapides</span>
            </div>

            <!-- Diagnostic auto (caché par défaut) -->
            <div id="diagnostic-panel" style="display:none;margin-bottom:28px;"></div>

            <!-- Modules -->
            <div class="page-header">
                <h2 style="font-size: 18px; font-weight: 700;">Modules</h2>
            </div>
            <div id="modules-grid" class="modules-grid"></div>

            <!-- Planification globale -->
            <div class="page-header" style="margin-top:28px;">
                <h2 style="font-size: 18px; font-weight: 700;">📅 Planification globale</h2>
                <p class="page-subtitle">Tâches planifiées sur tous les serveurs</p>
            </div>
            <div id="hub-scheduler" style="background:var(--bg-secondary);border-radius:12px;padding:20px;border:1px solid var(--border-color);">
                <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">⏳ Chargement des tâches...</div>
            </div>
        `;

        // Charger les tâches planifiées de tous les serveurs
        this._loadGlobalSchedule();
    },

    async _loadGlobalSchedule() {
        const schedEl = document.getElementById('hub-scheduler');
        if (!schedEl) return;

        const r = await Auth.apiCall('/api/servers');
        if (!r || !r.ok) { schedEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Aucun serveur</div>'; return; }
        const servers = await r.json();

        let allTasks = [];
        for (const s of servers) {
            const tr = await Auth.apiCall(`/api/scheduler/server/${s.id}`);
            if (tr && tr.ok) {
                const data = await tr.json();
                const tasks = data.tasks || data || [];
                if (Array.isArray(tasks)) {
                    tasks.forEach(t => allTasks.push({...t, serverName: s.name, serverId: s.id}));
                }
            }
        }

        if (allTasks.length === 0) {
            schedEl.innerHTML = `
                <div style="text-align:center;padding:30px;">
                    <div style="font-size:32px;margin-bottom:8px;">📅</div>
                    <div style="color:var(--text-muted);font-size:13px;">Aucune tâche planifiée</div>
                    <div style="color:var(--text-muted);font-size:12px;margin-top:4px;">Ajoutez des tâches via l'onglet "Tâches planifiées" de chaque serveur</div>
                </div>`;
            return;
        }

        const taskIcons = { start: '▶️', stop: '⏹️', restart: '🔄', backup: '💾', command: '💻' };

        schedEl.innerHTML = `
            <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">${allTasks.length} tâche(s) sur ${servers.length} serveur(s)</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
                ${allTasks.map(t => `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                        <span style="font-size:18px;">${taskIcons[t.action] || '📋'}</span>
                        <div style="flex:1;">
                            <div style="font-size:13px;font-weight:600;">${t.action || 'tâche'} ${t.value ? '· ' + t.value : ''}</div>
                            <div style="font-size:11px;color:var(--text-muted);">🎮 ${t.serverName} · ⏰ ${t.schedule || t.cron || 'non défini'}</div>
                        </div>
                        <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${t.enabled !== false ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)'};color:${t.enabled !== false ? 'var(--accent-green)' : 'var(--text-muted)'};">${t.enabled !== false ? '● Actif' : '○ Inactif'}</span>
                    </div>
                `).join('')}
            </div>`;
    },

    /**
     * Diagnostic auto — analyse la santé du système.
     */
    async runDiagnostic() {
        const panel = document.getElementById('diagnostic-panel');
        if (!panel) return;

        panel.style.display = 'block';
        panel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">🩺 Analyse en cours...</div>';

        const r = await Auth.apiCall('/api/diagnostic');
        if (!r || !r.ok) {
            panel.innerHTML = '<div style="color:#ef4444;padding:12px;">❌ Erreur de diagnostic</div>';
            return;
        }
        const d = await r.json();

        const levelColors = { ok: '#22c55e', warning: '#f59e0b', critical: '#ef4444' };
        const levelIcons = { ok: '✅', warning: '⚠️', critical: '🔴' };
        const levelBg = { ok: 'rgba(34,197,94,0.08)', warning: 'rgba(245,158,11,0.08)', critical: 'rgba(239,68,68,0.08)' };
        const overallLabel = { ok: '🟢 Tout va bien', warning: '🟡 Attention requise', critical: '🔴 Problèmes détectés' };

        panel.innerHTML = `
            <div style="background:var(--bg-secondary);border-radius:12px;padding:20px;border:1px solid var(--border-color);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <div>
                        <div style="font-size:16px;font-weight:700;">${overallLabel[d.overall] || '🩺 Diagnostic'}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${d.ok} OK · ${d.warnings} avertissement(s) · ${d.criticals} critique(s)</div>
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
        if (!r || !r.ok) { alert('❌ Erreur'); return; }
        const servers = await r.json();

        let stopped = 0;
        for (const s of servers) {
            if (s.status === 'running') {
                const sr = await Auth.apiCall(`/api/servers/${s.id}/stop`, { method: 'POST' });
                if (sr && sr.ok) stopped++;
            }
        }

        alert(`✅ ${stopped} serveur(s) arrêté(s)`);
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

        content.innerHTML = `
            <div class="page-header">
                <h1 class="page-title">⚙️ Paramètres</h1>
                <p class="page-subtitle">Configuration de ton serveur</p>
            </div>

            <div style="display: flex; flex-direction: column; gap: 20px; max-width: 600px;">
                <!-- Infos compte -->
                <div class="card">
                    <h3 class="card-title">👤 Compte</h3>
                    <div style="margin-top: 12px;">
                        <p><strong>Utilisateur :</strong> ${user ? user.username : '—'}</p>
                        <p><strong>Rôle :</strong> ${isAdmin ? '👑 Administrateur' : '🎮 Joueur'}</p>
                    </div>
                    <button class="btn btn-danger mt-4" onclick="Auth.logout()">
                        🚪 Se déconnecter
                    </button>
                </div>

                <!-- Changer mot de passe -->
                <div class="card">
                    <h3 class="card-title">🔑 Changer le mot de passe</h3>
                    <div style="margin-top: 16px;">
                        <div class="form-group">
                            <label class="form-label">Mot de passe actuel</label>
                            <input type="password" class="form-input" id="current-password" placeholder="••••••••" />
                        </div>
                        <div class="form-group">
                            <label class="form-label">Nouveau mot de passe</label>
                            <input type="password" class="form-input" id="new-password" placeholder="••••••••" />
                        </div>
                        <div class="form-group">
                            <label class="form-label">Confirmer le nouveau mot de passe</label>
                            <input type="password" class="form-input" id="confirm-password" placeholder="••••••••" />
                        </div>
                        <div id="password-message" style="font-size: 13px; margin-bottom: 12px;"></div>
                        <button class="btn btn-primary" onclick="App.changePassword()">
                            Changer le mot de passe
                        </button>
                    </div>
                </div>

                ${isAdmin ? `
                <!-- Invitations (admin only) -->
                <div class="card">
                    <div class="flex justify-between items-center">
                        <h3 class="card-title" style="margin: 0;">🎟️ Invitations</h3>
                        <button class="btn btn-primary btn-sm" onclick="App.createInvitation()">
                            ➕ Créer
                        </button>
                    </div>
                    <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
                        Génère un code d'invitation pour que tes amis puissent se créer un compte.
                    </p>
                    <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <select class="form-input" id="invite-role" style="flex: 1;">
                            <option value="player">🎮 Joueur (start/stop)</option>
                            <option value="moderator">🔧 Modérateur (console + backups)</option>
                            <option value="spectator">👀 Spectateur (voir seulement)</option>
                        </select>
                    </div>
                    <div id="invite-result" style="margin-top: 12px;"></div>
                    <div id="invitations-list" style="margin-top: 16px;">
                        <div style="text-align: center; padding: 16px; color: var(--text-muted); font-size: 13px;">Chargement...</div>
                    </div>
                </div>

                <!-- Utilisateurs (admin only) -->
                <div class="card">
                    <h3 class="card-title">👥 Utilisateurs</h3>
                    <div id="users-list" style="margin-top: 12px;">
                        <div style="text-align: center; padding: 16px; color: var(--text-muted); font-size: 13px;">Chargement...</div>
                    </div>
                </div>
                ` : ''}
            </div>
        `;

        // Charger les listes si admin
        if (isAdmin) {
            this.loadInvitations();
            this.loadUsers();
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
            msgEl.textContent = '❌ Remplis tous les champs';
            return;
        }
        if (newPwd !== confirm) {
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = '❌ Les mots de passe ne correspondent pas';
            return;
        }
        if (newPwd.length < 4) {
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = '❌ Le mot de passe doit faire au moins 4 caractères';
            return;
        }

        msgEl.style.color = 'var(--text-muted)';
        msgEl.textContent = '⏳ Changement en cours...';

        const response = await Auth.apiCall('/api/auth/change-password', {
            method: 'PUT',
            body: JSON.stringify({ current_password: current, new_password: newPwd }),
        });

        if (response && response.ok) {
            msgEl.style.color = '#2ecc71';
            msgEl.textContent = '✅ Mot de passe changé avec succès !';
            document.getElementById('current-password').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
        } else if (response) {
            const err = await response.json();
            msgEl.style.color = '#e74c3c';
            msgEl.textContent = `❌ ${err.detail || 'Erreur'}`;
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

    // --- Gestion des utilisateurs ---

    renderUsers(content) {
        content.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <div>
                <h1 style="margin:0;">👥 Gestion des utilisateurs</h1>
                <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">Créer, modifier ou supprimer des comptes</p>
            </div>
            <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Retour au Hub</button>
        </div>

        <!-- Créer un utilisateur -->
        <div class="card" style="margin-bottom:20px;">
            <h3 style="margin:0 0 16px;">➕ Créer un compte</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end;">
                <div>
                    <label class="form-label">Nom d'utilisateur</label>
                    <input id="new-user-name" class="form-input" placeholder="Ex: joueur123" />
                </div>
                <div>
                    <label class="form-label">Mot de passe</label>
                    <input id="new-user-pass" class="form-input" type="password" placeholder="Min. 4 caractères" />
                </div>
                <div>
                    <label class="form-label">Rôle</label>
                    <select id="new-user-role" class="form-input">
                        <option value="player">🎮 Joueur</option>
                        <option value="moderator">🔧 Modérateur</option>
                        <option value="admin">👑 Admin</option>
                        <option value="spectator">👀 Spectateur</option>
                    </select>
                </div>
                <button class="btn btn-primary" onclick="App.createUser()" style="height:38px;">Créer</button>
            </div>
            <div id="create-user-msg" style="font-size:13px;margin-top:8px;"></div>
        </div>

        <!-- Liste des utilisateurs -->
        <div class="card">
            <h3 style="margin:0 0 16px;">📋 Utilisateurs</h3>
            <div id="users-admin-list"><div style="text-align:center;padding:20px;color:var(--text-muted);">⏳ Chargement...</div></div>
        </div>
        `;
        this._loadUsersAdmin();
    },

    async createUser() {
        const name = document.getElementById('new-user-name')?.value?.trim();
        const pass = document.getElementById('new-user-pass')?.value;
        const role = document.getElementById('new-user-role')?.value || 'player';
        const msg = document.getElementById('create-user-msg');
        if (!name || !pass) { if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '\u274c Remplis tous les champs'; } return; }
        if (pass.length < 4) { if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '\u274c Mot de passe trop court (min 4)'; } return; }

        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '\u23f3 Cr\u00e9ation...'; }
        const r = await Auth.apiCall('/api/auth/admin/create-user', {
            method: 'POST', body: JSON.stringify({ username: name, password: pass, is_admin: role === 'admin' })
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = `\u2705 Utilisateur '${name}' cr\u00e9\u00e9 !`; }
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
        const listEl = document.getElementById('users-admin-list');
        if (!listEl) return;

        const response = await Auth.apiCall('/api/auth/admin/users');
        if (!response || !response.ok) { listEl.innerHTML = '<div style="color:#ef4444;">\u274c Erreur</div>'; return; }
        const users = await response.json();
        const currentUser = Auth.getUser();

        const roleLabels = { admin: '👑 Admin', moderator: '🔧 Modérateur', player: '🎮 Joueur', spectator: '👀 Spectateur' };
        const permLabels = {
            view: '👀 Voir', start: '▶️ Démarrer', stop: '⏹️ Arrêter', restart: '🔄 Restart',
            console: '💻 Console', backup: '💾 Backup', logs: '📋 Logs',
            create: '➕ Créer', delete: '🗑️ Supprimer', settings: '⚙️ Config',
            invite: '🎟️ Inviter', manage_users: '👥 Users'
        };
        const rolePerms = {
            spectator: ['view'],
            player: ['view','start','stop','restart'],
            moderator: ['view','start','stop','restart','console','backup','logs'],
            admin: Object.keys(permLabels)
        };

        listEl.innerHTML = users.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text-muted);">Aucun utilisateur</div>' :
            users.map(u => {
                const userPerms = rolePerms[u.role] || [];
                return `
            <div style="padding:12px 0;border-bottom:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <div style="width:36px;height:36px;border-radius:50%;background:${u.is_admin ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : 'var(--bg-secondary)'};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:${u.is_admin ? 'white' : 'var(--text-muted)'}">${u.username.charAt(0).toUpperCase()}</div>
                        <div>
                            <div style="font-weight:600;font-size:14px;">${u.username}</div>
                            <div style="font-size:12px;color:var(--text-muted);">${roleLabels[u.role] || u.role}${u.created_at ? ' · Créé le ' + new Date(u.created_at).toLocaleDateString('fr-FR') : ''}</div>
                        </div>
                    </div>
                    ${u.id !== currentUser?.id ? `
                        <div style="display:flex;align-items:center;gap:8px;">
                            <select class="form-input" style="font-size:12px;padding:4px 8px;width:auto;" onchange="App._changeRoleAdmin(${u.id}, this.value)">
                                <option value="spectator" ${u.role === 'spectator' ? 'selected' : ''}>👀 Spectateur</option>
                                <option value="player" ${u.role === 'player' ? 'selected' : ''}>🎮 Joueur</option>
                                <option value="moderator" ${u.role === 'moderator' ? 'selected' : ''}>🔧 Modérateur</option>
                                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 Admin</option>
                            </select>
                            <button class="btn btn-danger btn-sm" onclick="App._confirmDeleteUser(${u.id}, '${u.username}')" style="padding:4px 8px;font-size:12px;">🗑️</button>
                        </div>
                    ` : '<span style="font-size:12px;color:var(--accent-green);font-weight:600;">👑 Toi</span>'}
                </div>
                <!-- Permissions granulaires -->
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;padding-left:48px;">
                    ${Object.entries(permLabels).map(([k, label]) => {
                        const has = userPerms.includes(k);
                        return `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${has ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)'};color:${has ? 'var(--accent-green)' : 'rgba(255,255,255,0.15)'};border:1px solid ${has ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.05)'};">${label}</span>`;
                    }).join('')}
                </div>
            </div>
            <div id="del-confirm-${u.id}" style="display:none;background:rgba(239,68,68,0.08);border:1px solid #ef4444;border-radius:8px;padding:10px;margin:4px 0 8px;">
                <span style="font-size:12px;color:#ef4444;">Supprimer '${u.username}' ?</span>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('del-confirm-${u.id}').style.display='none'" style="margin-left:8px;font-size:11px;">Annuler</button>
                <button class="btn btn-sm" style="background:#ef4444;color:white;margin-left:4px;font-size:11px;" onclick="App._deleteUserAdmin(${u.id})">Supprimer</button>
            </div>`;
            }).join('');
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

    async loadUsers() {
        const listEl = document.getElementById('users-list');
        if (!listEl) return;

        const response = await Auth.apiCall('/api/auth/admin/users');
        if (!response || !response.ok) return;
        const users = await response.json();
        const currentUser = Auth.getUser();

        const roleLabels = { admin: '\ud83d\udc51 Admin', moderator: '\ud83d\udd27 Mod\u00e9rateur', player: '\ud83c\udfae Joueur', spectator: '\ud83d\udc40 Spectateur' };

        listEl.innerHTML = users.map(u => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-color);">
                <div>
                    <span style="font-weight:600;">${u.username}</span>
                    <span style="font-size:12px;color:var(--text-muted);"> \u00b7 ${roleLabels[u.role] || u.role}</span>
                </div>
                ${u.id !== currentUser?.id ? `
                    <div style="display:flex;gap:4px;align-items:center;">
                        <select class="form-input" style="font-size:11px;padding:4px 8px;width:auto;" onchange="App._changeRoleAdmin(${u.id}, this.value)">
                            <option value="spectator" ${u.role === 'spectator' ? 'selected' : ''}>\ud83d\udc40 Spectateur</option>
                            <option value="player" ${u.role === 'player' ? 'selected' : ''}>\ud83c\udfae Joueur</option>
                            <option value="moderator" ${u.role === 'moderator' ? 'selected' : ''}>\ud83d\udd27 Mod\u00e9rateur</option>
                            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>\ud83d\udc51 Admin</option>
                        </select>
                        <button class="btn btn-danger btn-sm" onclick="App._confirmDeleteUser(${u.id}, '${u.username}')" style="padding:2px 8px;font-size:11px;">\ud83d\uddd1\ufe0f</button>
                    </div>
                ` : '<span style="font-size:11px;color:var(--accent-green);">\ud83d\udc51 Toi</span>'}
            </div>
        `).join('');
    },

    async changeUserRole(userId, role) {
        await this._changeRoleAdmin(userId, role);
        this.loadUsers();
    },

    async deleteUser(userId, username) {
        this._confirmDeleteUser(userId, username);
    },
};

// Lancer l'app quand la page est charg\u00e9e
document.addEventListener('DOMContentLoaded', () => App.init());
