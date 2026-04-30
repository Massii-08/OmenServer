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
    },

    /**
     * Navigation entre les vues.
     * C'est la fonction principale qui change le contenu affiché.
     */
    async navigateTo(view) {
        // Décharger la vue précédente
        if (this.currentView === 'game_server') {
            GameServer.unload();
        }

        this.currentView = view;

        // Mettre à jour la sidebar
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });

        const content = document.getElementById('module-content');
        if (!content) return;

        switch (view) {
            case 'hub':
                this.renderHub(content);
                await Modules.loadHub();
                break;

            case 'game_server':
                await GameServer.load();
                break;

            case 'settings':
                this.renderSettings(content);
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

            <!-- Modules -->
            <div class="page-header">
                <h2 style="font-size: 18px; font-weight: 700;">Modules</h2>
            </div>
            <div id="modules-grid" class="modules-grid"></div>
        `;
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

    async loadUsers() {
        const listEl = document.getElementById('users-list');
        if (!listEl) return;

        const response = await Auth.apiCall('/api/auth/users');
        if (!response) return;
        const data = await response.json();
        const users = data.users || [];

        listEl.innerHTML = users.map(u => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-color);">
                <div>
                    <span style="font-weight: 600;">${u.username}</span>
                    <span style="font-size: 12px; color: var(--text-muted);"> · ${u.role_name}</span>
                    <span style="font-size: 11px; color: var(--text-muted);"> · ${u.created_at}</span>
                </div>
                ${!u.is_admin ? `
                    <div class="flex gap-2">
                        <select class="form-input" style="font-size: 11px; padding: 4px 8px; width: auto;" onchange="App.changeUserRole(${u.id}, this.value)">
                            <option value="spectator" ${u.role === 'spectator' ? 'selected' : ''}>👀 Spectateur</option>
                            <option value="player" ${u.role === 'player' ? 'selected' : ''}>🎮 Joueur</option>
                            <option value="moderator" ${u.role === 'moderator' ? 'selected' : ''}>🔧 Modérateur</option>
                            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 Admin</option>
                        </select>
                        <button class="btn btn-danger btn-sm" onclick="App.deleteUser(${u.id}, '${u.username}')" style="padding: 2px 8px; font-size: 11px;">🗑️</button>
                    </div>
                ` : '<span style="font-size: 11px; color: var(--accent-green);">👑 Toi</span>'}
            </div>
        `).join('');
    },

    async changeUserRole(userId, role) {
        const response = await Auth.apiCall(`/api/auth/users/${userId}/role`, {
            method: 'PUT',
            body: JSON.stringify({ role }),
        });
        if (response && response.ok) this.loadUsers();
    },

    async deleteUser(userId, username) {
        if (!confirm(`Supprimer l'utilisateur "${username}" ? Cette action est irréversible.`)) return;
        const response = await Auth.apiCall(`/api/auth/users/${userId}`, { method: 'DELETE' });
        if (response && response.ok) this.loadUsers();
    },
};

// Lancer l'app quand la page est chargée
document.addEventListener('DOMContentLoaded', () => App.init());
