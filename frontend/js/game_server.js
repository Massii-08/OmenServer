/**
 * GameServer.js — Interface du module Serveurs de jeux.
 * 
 * Supporte tous les jeux : Minecraft, ARK, Valheim, Terraria, CS2, etc.
 * Affiche l'IP de connexion et le port pour chaque serveur.
 */

const GameServer = {
    _statusInterval: null,
    _games: [],       // Liste des jeux supportés
    _serverIP: '',    // IP locale du serveur
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
            <div class="page-header flex justify-between items-center">
                <div>
                    <h1 class="page-title">🎮 Serveurs de jeux</h1>
                    <p class="page-subtitle">Gérer tes serveurs — ${this._games.length} jeux supportés</p>
                </div>
                <div class="flex gap-2">
                    <button class="btn btn-primary" onclick="GameServer.showCreateModal()">
                        ➕ Nouveau serveur
                    </button>
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">
                        ← Retour au Hub
                    </button>
                </div>
            </div>

            <!-- Bannière IP de connexion -->
            <div style="background: var(--bg-card); border: 1px solid var(--border-active); border-radius: var(--border-radius); padding: 14px 20px; margin-bottom: 20px; display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 20px;">🌐</span>
                <div>
                    <div style="font-size: 13px; color: var(--text-secondary);">IP de connexion pour les joueurs</div>
                    <div style="font-size: 18px; font-weight: 700; color: var(--accent-green); font-family: monospace;">
                        ${this._serverIP || 'Chargement...'}
                    </div>
                </div>
                <button class="btn btn-secondary btn-sm" style="margin-left: auto;" onclick="GameServer.copyIP()">📋 Copier</button>
            </div>

            <div id="docker-warning" class="hidden" style="background: var(--accent-yellow); color: #000; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 13px;">
                ⚠️ Docker n'est pas disponible. Lance Docker Desktop pour gérer les serveurs.
            </div>

            <div id="server-list" class="server-list">
                <div class="text-center" style="padding: 40px; color: var(--text-muted);">
                    Chargement...
                </div>
            </div>

            <!-- Modal création -->
            <div id="create-modal" class="modal-overlay">
                <div class="modal" style="max-width: 520px;">
                    <h2 class="modal-title">➕ Nouveau serveur</h2>
                    
                    <div class="form-group">
                        <label class="form-label">Jeu</label>
                        <select class="form-input" id="server-game-type" onchange="GameServer.onGameChange()">
                            ${gameOptions}
                        </select>
                    </div>
                    <div id="game-description" style="font-size: 12px; color: var(--text-muted); margin-top: -12px; margin-bottom: 16px;">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Nom du serveur</label>
                        <input type="text" class="form-input" id="server-name" placeholder="Mon serveur" />
                    </div>
                    <div class="form-group" id="version-group">
                        <label class="form-label">Version</label>
                        <input type="text" class="form-input" id="server-version" value="LATEST" placeholder="LATEST, 1.21.4..." />
                    </div>
                    <div class="form-group" id="custom-image-group" style="display: none;">
                        <label class="form-label">Image Docker</label>
                        <input type="text" class="form-input" id="server-custom-image" placeholder="mon-image:latest" />
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <div class="form-group" style="flex: 1;">
                            <label class="form-label">Port</label>
                            <input type="number" class="form-input" id="server-port" value="25565" />
                        </div>
                        <div class="form-group" style="flex: 1;">
                            <label class="form-label">RAM (Mo)</label>
                            <input type="number" class="form-input" id="server-memory" value="2048" step="512" />
                        </div>
                    </div>
                    <div id="create-error" class="login-error"></div>
                    <div id="create-loading" class="hidden" style="text-align: center; padding: 12px; color: var(--text-secondary); font-size: 13px;">
                        ⏳ Téléchargement de l'image Docker... Ça peut prendre quelques minutes la première fois.
                    </div>
                    <div id="create-buttons" class="flex gap-2 mt-4">
                        <button class="btn btn-primary" onclick="GameServer.createServer()">Créer le serveur</button>
                        <button class="btn btn-secondary" onclick="GameServer.hideCreateModal()">Annuler</button>
                    </div>
                </div>
            </div>

            <!-- Modal console live -->
            <div id="logs-modal" class="modal-overlay">
                <div class="modal" style="max-width: 800px;">
                    <div class="flex justify-between items-center mb-4">
                        <div class="flex items-center gap-3">
                            <h2 class="modal-title" style="margin: 0;">📋 Console live</h2>
                            <span id="console-status" style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-hover); color: var(--text-muted);">Déconnecté</span>
                        </div>
                        <button class="btn btn-secondary btn-sm" onclick="GameServer.hideLogsModal()">✕ Fermer</button>
                    </div>
                    <div id="server-logs" class="console" style="height: 400px; overflow-y: auto; font-size: 12px; line-height: 1.6;">Connexion en cours...</div>
                    <div style="display: flex; gap: 8px; margin-top: 8px;">
                        <input type="text" class="form-input" id="console-command" placeholder="Envoie une commande... (ex: say Hello)" style="flex: 1; font-family: monospace; font-size: 13px;" onkeydown="if(event.key==='Enter') GameServer.sendCommand()" />
                        <button class="btn btn-primary" onclick="GameServer.sendCommand()">Envoyer</button>
                    </div>
                </div>
            </div>

            <!-- Modal sauvegardes -->
            <div id="backups-modal" class="modal-overlay">
                <div class="modal" style="max-width: 650px;">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="modal-title" style="margin: 0;">💾 Sauvegardes</h2>
                        <div class="flex gap-2">
                            <button class="btn btn-primary btn-sm" id="backup-create-btn" onclick="GameServer.createBackup()">
                                ➕ Sauvegarder maintenant
                            </button>
                            <button class="btn btn-secondary btn-sm" onclick="GameServer.hideBackupsModal()">✕ Fermer</button>
                        </div>
                    </div>
                    <div id="backups-list" style="max-height: 400px; overflow-y: auto;">
                        <div style="text-align: center; padding: 30px; color: var(--text-muted);">Chargement...</div>
                    </div>
                </div>
            </div>

            <!-- Modal confirmation suppression -->
            <div id="delete-modal" class="modal-overlay">
                <div class="modal" style="max-width: 400px; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                    <h2 class="modal-title">Supprimer ce serveur ?</h2>
                    <p style="color: var(--text-muted); margin-bottom: 20px;">Cette action est irréversible. Toutes les données seront perdues.</p>
                    <div class="flex gap-2" style="justify-content: center;">
                        <button class="btn btn-danger" id="delete-confirm-btn" onclick="GameServer.confirmDelete()">🗑️ Supprimer</button>
                        <button class="btn btn-secondary" onclick="GameServer.hideDeleteModal()">Annuler</button>
                    </div>
                </div>
            </div>

            <!-- Modal réglages ressources -->
            <div id="resources-modal" class="modal-overlay">
                <div class="modal" style="max-width: 500px;">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="modal-title" style="margin: 0;">⚙️ Réglages ressources</h2>
                        <button class="btn btn-secondary btn-sm" onclick="GameServer.hideResourcesModal()">✕ Fermer</button>
                    </div>

                    <!-- RAM Slider -->
                    <div style="margin-bottom: 24px;">
                        <div class="flex justify-between items-center" style="margin-bottom: 8px;">
                            <label class="form-label" style="margin: 0;">💻 Mémoire RAM</label>
                            <span id="ram-value" style="font-family: monospace; font-weight: 700; color: var(--accent-blue); font-size: 16px;">2048 Mo</span>
                        </div>
                        <input type="range" id="ram-slider" min="256" max="8192" step="256" value="2048"
                            style="width: 100%; accent-color: var(--accent-blue); cursor: pointer;"
                            oninput="document.getElementById('ram-value').textContent = this.value + ' Mo'" />
                        <div class="flex justify-between" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                            <span>256 Mo</span>
                            <span>8192 Mo (8 Go)</span>
                        </div>
                    </div>

                    <!-- CPU Slider -->
                    <div style="margin-bottom: 24px;">
                        <div class="flex justify-between items-center" style="margin-bottom: 8px;">
                            <label class="form-label" style="margin: 0;">⚡ CPU</label>
                            <span id="cpu-value" style="font-family: monospace; font-weight: 700; color: var(--accent-orange); font-size: 16px;">100%</span>
                        </div>
                        <input type="range" id="cpu-slider" min="25" max="400" step="25" value="100"
                            style="width: 100%; accent-color: var(--accent-orange); cursor: pointer;"
                            oninput="document.getElementById('cpu-value').textContent = this.value + '%'" />
                        <div class="flex justify-between" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                            <span>25% (¼ cœur)</span>
                            <span>400% (4 cœurs)</span>
                        </div>
                    </div>

                    <div id="resources-message" style="font-size: 13px; margin-bottom: 12px;"></div>
                    <button class="btn btn-primary" id="resources-save-btn" onclick="GameServer.saveResources()" style="width: 100%;">
                        💾 Appliquer les changements
                    </button>
                </div>
            </div>

            <!-- Modal tâches planifiées -->
            <div id="scheduler-modal" class="modal-overlay">
                <div class="modal" style="max-width: 550px;">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="modal-title" style="margin: 0;">⏰ Tâches planifiées</h2>
                        <button class="btn btn-secondary btn-sm" onclick="GameServer.hideSchedulerModal()">✕ Fermer</button>
                    </div>

                    <!-- Formulaire nouvelle tâche -->
                    <div style="background: var(--bg-secondary); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                        <div class="form-label" style="margin-bottom: 8px;">Nouvelle tâche</div>
                        <div class="flex gap-2" style="align-items: flex-end;">
                            <div style="flex: 1;">
                                <label style="font-size: 12px; color: var(--text-muted);">Type</label>
                                <select id="scheduler-type" class="form-input" style="margin-top: 4px;">
                                    <option value="backup">💾 Backup auto</option>
                                    <option value="restart">🔄 Redémarrage auto</option>
                                </select>
                            </div>
                            <div style="flex: 1;">
                                <label style="font-size: 12px; color: var(--text-muted);">Intervalle</label>
                                <select id="scheduler-interval" class="form-input" style="margin-top: 4px;">
                                    <option value="1">Toutes les 1h</option>
                                    <option value="3">Toutes les 3h</option>
                                    <option value="6" selected>Toutes les 6h</option>
                                    <option value="12">Toutes les 12h</option>
                                    <option value="24">Toutes les 24h</option>
                                    <option value="48">Toutes les 48h</option>
                                    <option value="168">Toutes les semaines</option>
                                </select>
                            </div>
                            <button class="btn btn-primary" onclick="GameServer.createScheduledTask()">➕ Ajouter</button>
                        </div>
                    </div>

                    <!-- Liste des tâches -->
                    <div id="scheduler-tasks-list">
                        <div style="text-align: center; padding: 20px; color: var(--text-muted);">⏳ Chargement...</div>
                    </div>
                    <div id="scheduler-message" style="font-size: 13px; margin-top: 8px;"></div>
                </div>
            </div>
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
            btn.textContent = '✅ Copié !';
            setTimeout(() => btn.textContent = original, 1500);
        });
    },

    /**
     * Met à jour les champs quand on change de jeu.
     */
    onGameChange() {
        const select = document.getElementById('server-game-type');
        if (!select) return;

        const gameType = select.value;
        const game = this._games.find(g => g.id === gameType);
        if (!game) return;

        // Mettre à jour le port et la RAM par défaut
        document.getElementById('server-port').value = game.default_port;
        document.getElementById('server-memory').value = game.default_memory_mb;

        // Afficher la description du jeu
        const descEl = document.getElementById('game-description');
        if (descEl) descEl.textContent = game.description || '';

        // Afficher/masquer le champ version (seulement si le jeu supporte les versions)
        const versionGroup = document.getElementById('version-group');
        if (versionGroup) {
            versionGroup.style.display = game.version_env ? 'block' : 'none';
        }

        // Afficher/masquer le champ image Docker (seulement pour "custom")
        const customGroup = document.getElementById('custom-image-group');
        if (customGroup) {
            customGroup.style.display = gameType === 'custom' ? 'block' : 'none';
        }
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
                <div class="text-center" style="padding: 60px; color: var(--text-muted);">
                    <div style="font-size: 48px; margin-bottom: 16px;">🎮</div>
                    <p style="font-size: 16px; margin-bottom: 8px;">Aucun serveur pour le moment</p>
                    <p style="font-size: 13px;">Clique sur "Nouveau serveur" pour en créer un !</p>
                </div>
            `;
            return;
        }

        list.innerHTML = servers.map(server => {
            const isRunning = server.status === 'running';
            const statusClass = isRunning ? 'online' : (server.status === 'error' ? 'error' : 'offline');
            const statusText = isRunning ? 'En ligne' : (server.status === 'error' ? 'Erreur' : 'Arrêté');

            // Trouver l'icône du jeu
            const game = this._games.find(g => g.id === server.game_type);
            const icon = game ? game.icon : '🎮';
            const gameName = game ? game.name : server.game_type;

            // Adresse de connexion
            const connectAddr = `${this._serverIP}:${server.port}`;

            return `
                <div class="server-item fade-in">
                    <div class="server-info">
                        <span class="server-icon">${icon}</span>
                        <div>
                            <div class="server-name">${server.name}</div>
                            <div class="server-meta">
                                ${gameName} · v${server.version} · ${server.memory_mb} Mo RAM · ${server.cpu_percent || 100}% CPU
                            </div>
                            <div style="margin-top: 4px; font-family: monospace; font-size: 12px; color: ${isRunning ? 'var(--accent-green)' : 'var(--text-muted)'};">
                                📡 ${connectAddr}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-4">
                        <span class="status-badge ${statusClass}">
                            <span class="status-dot ${statusClass}"></span>
                            ${statusText}
                        </span>
                        <div class="server-actions">
                            ${isRunning ? `
                                <button class="btn btn-icon btn-secondary" onclick="GameServer.stopServer(${server.id})" title="Arrêter">⏹️</button>
                                <button class="btn btn-icon btn-secondary" onclick="GameServer.restartServer(${server.id})" title="Redémarrer">🔄</button>
                            ` : `
                                <button class="btn btn-icon btn-primary" onclick="GameServer.startServer(${server.id})" title="Démarrer">▶️</button>
                            `}
                            <button class="btn btn-icon btn-secondary" onclick="GameServer.showLogs(${server.id})" title="Console">📋</button>
                            <button class="btn btn-icon btn-secondary" onclick="GameServer.showBackups(${server.id})" title="Sauvegardes">💾</button>
                            <button class="btn btn-icon btn-secondary" onclick="GameServer.showResources(${server.id}, ${server.memory_mb}, ${server.cpu_percent || 100})" title="Ressources">⚙️</button>
                            <button class="btn btn-icon btn-secondary" onclick="GameServer.showScheduler(${server.id})" title="Planification">⏰</button>
                            <button class="btn btn-icon btn-danger" onclick="GameServer.deleteServer(${server.id})" title="Supprimer">🗑️</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    startStatusRefresh() {
        this._statusInterval = setInterval(() => this.refreshServers(), 5000);
    },

    // --- Actions serveur ---

    async startServer(id) {
        const response = await Auth.apiCall(`/api/servers/${id}/start`, { method: 'POST' });
        if (response && response.ok) await this.refreshServers();
    },

    async stopServer(id) {
        const response = await Auth.apiCall(`/api/servers/${id}/stop`, { method: 'POST' });
        if (response && response.ok) await this.refreshServers();
    },

    async restartServer(id) {
        const response = await Auth.apiCall(`/api/servers/${id}/restart`, { method: 'POST' });
        if (response && response.ok) await this.refreshServers();
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
        if (btn) { btn.disabled = false; btn.innerHTML = '🗑️ Supprimer'; }
    },

    hideDeleteModal() {
        const modal = document.getElementById('delete-modal');
        if (modal) modal.classList.remove('active');
        this._deleteServerId = null;
        // Reset le bouton
        const btn = document.getElementById('delete-confirm-btn');
        if (btn) { btn.disabled = false; btn.innerHTML = '🗑️ Supprimer'; }
        // Redémarrer le refresh
        this.startStatusRefresh();
    },

    async confirmDelete() {
        const id = this._deleteServerId;
        if (!id) return;

        const btn = document.getElementById('delete-confirm-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Suppression...'; }

        try {
            const response = await Auth.apiCall(`/api/servers/${id}`, { method: 'DELETE' });

            // Fermer le modal DANS TOUS LES CAS
            this.hideDeleteModal();

            if (response && response.ok) {
                await this.refreshServers();
            } else if (response) {
                const err = await response.json();
                alert(`Erreur: ${err.detail || 'Impossible de supprimer'}`);
            }
        } catch (e) {
            this.hideDeleteModal();
            alert('Erreur réseau lors de la suppression');
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

        if (ramSlider) { ramSlider.value = currentRam; }
        if (cpuSlider) { cpuSlider.value = currentCpu; }
        if (ramValue) { ramValue.textContent = currentRam + ' Mo'; }
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

        const ram = parseInt(document.getElementById('ram-slider').value);
        const cpu = parseInt(document.getElementById('cpu-slider').value);
        const btn = document.getElementById('resources-save-btn');
        const msgEl = document.getElementById('resources-message');

        if (btn) { btn.disabled = true; btn.textContent = '⏳ Application...'; }

        try {
            const response = await Auth.apiCall(`/api/servers/${id}/resources`, {
                method: 'PUT',
                body: JSON.stringify({ memory_mb: ram, cpu_percent: cpu }),
            });

            if (btn) { btn.disabled = false; btn.innerHTML = '💾 Appliquer les changements'; }

            if (response && response.ok) {
                if (msgEl) {
                    msgEl.style.color = 'var(--accent-green)';
                    msgEl.textContent = '✅ Ressources mises à jour !';
                }
                await this.refreshServers();
                // Fermer après 1s
                setTimeout(() => this.hideResourcesModal(), 1000);
            } else if (response) {
                const err = await response.json();
                if (msgEl) {
                    msgEl.style.color = '#e74c3c';
                    msgEl.textContent = `❌ ${err.detail || 'Erreur'}`;
                }
            }
        } catch (e) {
            if (btn) { btn.disabled = false; btn.innerHTML = '💾 Appliquer les changements'; }
            if (msgEl) {
                msgEl.style.color = '#e74c3c';
                msgEl.textContent = '❌ Erreur réseau';
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
            const typeEmoji = task.task_type === 'backup' ? '💾' : '🔄';
            const typeLabel = task.task_type === 'backup' ? 'Backup' : 'Redémarrage';
            const statusColor = task.enabled ? 'var(--accent-green)' : 'var(--text-muted)';
            const statusLabel = task.enabled ? '● Actif' : '○ Inactif';
            const lastRun = task.last_run ? new Date(task.last_run).toLocaleString('fr-FR') : 'Jamais';
            const nextRun = task.next_run && task.enabled ? new Date(task.next_run).toLocaleString('fr-FR') : '—';

            return `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:8px;">
                    <div>
                        <div style="font-weight:600;">${typeEmoji} ${typeLabel} auto</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
                            ⏱️ Toutes les ${task.interval_hours}h &nbsp;|&nbsp;
                            📅 Dernier: ${lastRun} &nbsp;|&nbsp;
                            ⏭️ Prochain: ${nextRun}
                        </div>
                    </div>
                    <div class="flex gap-2" style="align-items:center;">
                        <span style="color:${statusColor};font-size:12px;font-weight:600;">${statusLabel}</span>
                        <button class="btn btn-icon btn-secondary" onclick="GameServer.toggleScheduledTask(${task.id})" title="${task.enabled ? 'Désactiver' : 'Activer'}">
                            ${task.enabled ? '⏸️' : '▶️'}
                        </button>
                        <button class="btn btn-icon btn-danger" onclick="GameServer.deleteScheduledTask(${task.id})" title="Supprimer">🗑️</button>
                    </div>
                </div>
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
            if (msgEl) { msgEl.style.color = 'var(--accent-green)'; msgEl.textContent = '✅ Tâche créée !'; }
            await this.loadSchedulerTasks();
        } else if (response) {
            const err = await response.json();
            if (msgEl) { msgEl.style.color = '#e74c3c'; msgEl.textContent = `❌ ${err.detail || 'Erreur'}`; }
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
            statusEl.style.background = 'var(--accent-yellow)';
            statusEl.style.color = '#000';
        }

        try {
            this._consoleWS = new WebSocket(wsUrl);

            this._consoleWS.onopen = () => {
                if (statusEl) {
                    statusEl.textContent = '🟢 En direct';
                    statusEl.style.background = 'rgba(46, 204, 113, 0.2)';
                    statusEl.style.color = 'var(--accent-green)';
                }
            };

            this._consoleWS.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                this.appendConsoleLine(msg);
            };

            this._consoleWS.onclose = () => {
                if (statusEl) {
                    statusEl.textContent = 'Déconnecté';
                    statusEl.style.background = 'var(--bg-hover)';
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
            statusEl.style.background = 'var(--bg-hover)';
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
            line.style.color = '#e74c3c';
            line.textContent = `❌ ${text}`;
        } else if (msg.type === 'info') {
            line.style.color = 'var(--accent-blue)';
            line.textContent = text;
        } else {
            line.style.color = 'var(--text-primary)';
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
    },

    hideCreateModal() {
        const modal = document.getElementById('create-modal');
        if (modal) modal.classList.remove('active');
    },

    async createServer() {
        const name = document.getElementById('server-name').value.trim();
        const gameType = document.getElementById('server-game-type').value;
        const version = document.getElementById('server-version').value.trim();
        const port = parseInt(document.getElementById('server-port').value);
        const memory = parseInt(document.getElementById('server-memory').value);
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
        if (gameType === 'custom' && customImage) {
            body.custom_image = customImage;
        }

        const response = await Auth.apiCall('/api/servers/', {
            method: 'POST',
            body: JSON.stringify(body),
        });

        document.getElementById('create-loading').classList.add('hidden');
        document.getElementById('create-buttons').style.display = '';

        if (response && response.ok) {
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
                <div style="text-align: center; padding: 40px; color: var(--text-muted);">
                    <div style="font-size: 36px; margin-bottom: 12px;">📦</div>
                    <p>Aucune sauvegarde pour le moment</p>
                    <p style="font-size: 12px;">Clique sur "Sauvegarder maintenant" pour en créer une</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = backups.map(b => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border-color);">
                <div>
                    <div style="font-weight: 600; font-size: 14px;">📦 ${b.filename}</div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                        🕐 ${b.created_at} · 📊 ${b.size_mb} Mo
                    </div>
                </div>
                <div class="flex gap-2">
                    <button class="btn btn-secondary btn-sm" onclick="GameServer.restoreBackup('${b.id}')" title="Restaurer">
                        🔄 Restaurer
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="GameServer.deleteBackup('${b.id}')" title="Supprimer">
                        🗑️
                    </button>
                </div>
            </div>
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
            btn.textContent = '⏳ Sauvegarde en cours...';
        }

        const response = await Auth.apiCall(`/api/servers/${id}/backup`, { method: 'POST' });

        if (btn) {
            btn.disabled = false;
            btn.textContent = '➕ Sauvegarder maintenant';
        }

        if (response && response.ok) {
            await this.refreshBackups();
        } else if (response) {
            const err = await response.json();
            alert(`Erreur: ${err.detail || 'Impossible de sauvegarder'}`);
        }
    },

    /**
     * Restaure une sauvegarde (demande confirmation).
     */
    async restoreBackup(backupId) {
        if (!confirm('⚠️ Restaurer cette sauvegarde ?\n\nLe serveur doit être arrêté.\nLes données actuelles seront remplacées.')) return;

        const id = this._currentBackupServerId;
        if (!id) return;

        const response = await Auth.apiCall(`/api/servers/${id}/restore/${backupId}`, { method: 'POST' });

        if (response && response.ok) {
            alert('✅ Sauvegarde restaurée avec succès !');
        } else if (response) {
            const err = await response.json();
            alert(`Erreur: ${err.detail || 'Impossible de restaurer'}`);
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
            alert(`Erreur: ${err.detail || 'Impossible de supprimer'}`);
        }
    },
};
