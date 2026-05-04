/**
 * MediaModule — Interface du Module Média & Streaming (Jellyfin).
 *
 * Permet de déployer, gérer et monitorer un serveur Jellyfin
 * directement depuis le panel OmenServer.
 */
const MediaModule = {
    _refreshInterval: null,
    _status: null,

    async render(container) {
        console.log('[MediaModule] render() called');
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                <div>
                    <h1 style="margin:0;">📺 Média & Streaming</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">Serveur Jellyfin — Films, Séries, Musique</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Hub</button>
                </div>
            </div>

            <div id="media-status-card"></div>
            <div id="media-controls" style="margin-top:16px;"></div>
            <div id="media-libraries" style="margin-top:20px;"></div>
            <div id="media-info" style="margin-top:20px;"></div>
        `;

        await this.loadStatus();
        this._refreshInterval = setInterval(() => this.loadStatus(), 8000);
    },

    unload() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
        }
    },

    async loadStatus() {
        const r = await Auth.apiCall('/api/media/status');
        if (!r || !r.ok) {
            this._renderError();
            return;
        }
        this._status = await r.json();
        this._renderStatusCard();
        this._renderControls();
        if (this._status.installed) {
            await this._loadLibraries();
        }
    },

    _renderError() {
        const card = document.getElementById('media-status-card');
        if (!card) return;
        card.innerHTML = `
            <div class="card" style="border:1px solid #ef4444;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:32px;">⚠️</span>
                    <div>
                        <div style="font-weight:700;font-size:15px;color:#ef4444;">Docker non disponible</div>
                        <div style="font-size:13px;color:var(--text-muted);margin-top:4px;">
                            Vérifie que Docker est installé et lancé sur le serveur.
                        </div>
                    </div>
                </div>
            </div>`;
    },

    _renderStatusCard() {
        const card = document.getElementById('media-status-card');
        if (!card) return;
        const s = this._status;

        if (!s.installed) {
            card.innerHTML = `
                <div class="card" style="text-align:center;padding:48px;">
                    <div style="font-size:56px;margin-bottom:16px;">📺</div>
                    <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Jellyfin n'est pas installé</div>
                    <div style="color:var(--text-muted);font-size:13px;margin-bottom:24px;">
                        Jellyfin est un serveur multimédia gratuit et open-source.<br>
                        Il te permet de streamer tes films, séries et musique depuis n'importe quel appareil.
                    </div>
                    <button class="btn btn-primary" onclick="MediaModule.setup()" id="media-setup-btn" style="font-size:15px;padding:12px 32px;">
                        🚀 Installer Jellyfin
                    </button>
                    <div id="media-setup-msg" style="margin-top:12px;font-size:13px;"></div>
                </div>`;
            return;
        }

        const isRunning = s.status === 'running';
        const statusColor = isRunning ? '#22c55e' : '#6b7280';
        const statusLabel = isRunning ? '● En cours' : '○ Arrêté';
        const statusBg = isRunning ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.04)';

        card.innerHTML = `
            <div class="card">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div style="display:flex;align-items:center;gap:16px;">
                        <div style="width:56px;height:56px;border-radius:12px;background:linear-gradient(135deg,#8b5cf6,#6366f1);display:flex;align-items:center;justify-content:center;font-size:28px;">📺</div>
                        <div>
                            <div style="font-size:18px;font-weight:700;">Jellyfin</div>
                            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Serveur Multimédia</div>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:13px;padding:4px 12px;border-radius:6px;color:${statusColor};background:${statusBg};font-weight:600;display:inline-block;">
                            ${statusLabel}
                        </div>
                        ${isRunning ? `
                            <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">
                                CPU: ${s.cpu_percent || 0}% · RAM: ${s.ram_mb || 0} Mo
                            </div>
                        ` : ''}
                    </div>
                </div>
                ${isRunning ? `
                    <div style="margin-top:16px;padding:12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;">
                        <div>
                            <div style="font-size:12px;color:var(--text-muted);">Accès Jellyfin</div>
                            <a href="${s.url}" target="_blank" style="color:var(--accent-blue);font-size:14px;font-weight:600;text-decoration:none;">
                                ${s.url} ↗
                            </a>
                        </div>
                        <button class="btn btn-primary btn-sm" onclick="window.open('${s.url}', '_blank')" style="font-size:12px;">
                            🎬 Ouvrir Jellyfin
                        </button>
                    </div>
                ` : ''}
            </div>`;
    },

    _renderControls() {
        const el = document.getElementById('media-controls');
        if (!el) return;
        const s = this._status;

        if (!s.installed) {
            el.innerHTML = '';
            return;
        }

        const isRunning = s.status === 'running';
        el.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${isRunning ? `
                    <button class="btn btn-danger" onclick="MediaModule.stop()">⏹ Arrêter</button>
                    <button class="btn btn-secondary" onclick="MediaModule.restart()">🔄 Redémarrer</button>
                ` : `
                    <button class="btn btn-primary" onclick="MediaModule.start()">▶ Démarrer</button>
                `}
                <button class="btn btn-secondary" onclick="MediaModule.showAddLibrary()">📁 Ajouter une bibliothèque</button>
                <button class="btn btn-secondary" style="color:#ef4444;" onclick="MediaModule.reset()">🗑 Réinstaller</button>
            </div>
            <div id="media-add-library-form" style="display:none;margin-top:12px;"></div>
        `;
    },

    async _loadLibraries() {
        const el = document.getElementById('media-libraries');
        if (!el) return;

        const r = await Auth.apiCall('/api/media/libraries');
        if (!r || !r.ok) return;
        const data = await r.json();
        const libs = data.libraries || [];

        const typeIcons = { films: '🎬', series: '📺', musique: '🎵', books: '📚' };

        el.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;font-size:16px;">📁 Bibliothèques</h3>
                    <span style="font-size:12px;color:var(--text-muted);">${libs.length} dossier(s)</span>
                </div>
                ${libs.length === 0 ? `
                    <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
                        Aucune bibliothèque. Ajoute des dossiers de films, séries ou musique.
                    </div>
                ` : `
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        ${libs.map(lib => `
                            <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                                <span style="font-size:24px;">${typeIcons[lib.name] || '📂'}</span>
                                <div style="flex:1;">
                                    <div style="font-size:14px;font-weight:600;text-transform:capitalize;">${lib.name}</div>
                                    <div style="font-size:11px;color:var(--text-muted);">${lib.file_count} fichier(s) · ${lib.size_mb} Mo</div>
                                </div>
                                <span style="font-size:11px;color:var(--text-muted);font-family:monospace;">${lib.path}</span>
                            </div>
                        `).join('')}
                    </div>
                `}
            </div>`;
    },

    showAddLibrary() {
        const form = document.getElementById('media-add-library-form');
        if (!form) return;
        form.style.display = 'block';
        form.innerHTML = `
            <div class="card">
                <h3 style="margin:0 0 12px;font-size:14px;">📁 Ajouter une bibliothèque</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
                    <div>
                        <label class="form-label">Nom</label>
                        <input id="lib-name" class="form-input" placeholder="Ex: animes, documentaires..." />
                    </div>
                    <div>
                        <label class="form-label">Type</label>
                        <select id="lib-type" class="form-input">
                            <option value="movies">🎬 Films</option>
                            <option value="shows">📺 Séries</option>
                            <option value="music">🎵 Musique</option>
                            <option value="books">📚 Livres</option>
                        </select>
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-primary btn-sm" onclick="MediaModule.addLibrary()">Créer</button>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('media-add-library-form').style.display='none'">Annuler</button>
                    <span id="lib-msg" style="font-size:12px;"></span>
                </div>
            </div>`;
    },

    async addLibrary() {
        const name = document.getElementById('lib-name')?.value?.trim();
        const type = document.getElementById('lib-type')?.value || 'movies';
        const msg = document.getElementById('lib-msg');

        if (!name) { if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ Nom requis'; } return; }

        const r = await Auth.apiCall('/api/media/libraries', {
            method: 'POST',
            body: JSON.stringify({ name, media_type: type, path: '' })
        });

        if (r && r.ok) {
            document.getElementById('media-add-library-form').style.display = 'none';
            await this._loadLibraries();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async setup() {
        const btn = document.getElementById('media-setup-btn');
        const msg = document.getElementById('media-setup-msg');

        if (btn) { btn.disabled = true; btn.textContent = '⏳ Installation en cours...'; }
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = 'Téléchargement de l\'image Jellyfin... Cela peut prendre quelques minutes.'; }

        const r = await Auth.apiCall('/api/media/setup', { method: 'POST', body: JSON.stringify({ port: 8096 }) });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Jellyfin installé avec succès !'; }
            setTimeout(() => this.loadStatus(), 1500);
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (btn) { btn.disabled = false; btn.textContent = '🚀 Installer Jellyfin'; }
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur lors de l\'installation'}`; }
        }
    },

    async start() {
        const r = await Auth.apiCall('/api/media/start', { method: 'POST' });
        if (r && r.ok) await this.loadStatus();
        else { const err = r ? await r.json().catch(() => ({})) : {}; alert(`❌ ${err.detail || 'Erreur'}`); }
    },

    async stop() {
        const r = await Auth.apiCall('/api/media/stop', { method: 'POST' });
        if (r && r.ok) await this.loadStatus();
    },

    async restart() {
        const r = await Auth.apiCall('/api/media/restart', { method: 'POST' });
        if (r && r.ok) await this.loadStatus();
    },

    async reset() {
        if (!confirm('⚠️ Supprimer Jellyfin ?\n\nLe conteneur sera supprimé mais les fichiers média seront conservés.\n\nContinuer ?')) return;

        const r = await Auth.apiCall('/api/media/reset', { method: 'DELETE' });
        if (r && r.ok) await this.loadStatus();
        else { const err = r ? await r.json().catch(() => ({})) : {}; alert(`❌ ${err.detail || 'Erreur'}`); }
    },
};
