/**
 * FilesModule — Interface du Module Fichiers & Cloud.
 * 
 * Cloud personnel + intégration Google Drive.
 */
const FilesModule = {
    _gdriveStatus: null,
    _currentFolder: 'root',

    async render(container) {
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                <div>
                    <h1 style="margin:0;">📁 Fichiers & Cloud</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">Cloud personnel + Google Drive</p>
                </div>
                <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Hub</button>
            </div>

            <!-- Status Google Drive -->
            <div id="gdrive-status" class="card" style="margin-bottom:20px;">
                <div style="text-align:center;padding:20px;color:var(--text-muted);">⏳ Vérification de Google Drive...</div>
            </div>

            <!-- Navigateur de fichiers Drive -->
            <div id="gdrive-browser" style="display:none;">
                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                        <h3 style="margin:0;">☁️ Google Drive</h3>
                        <div style="display:flex;gap:8px;">
                            <button class="btn btn-secondary btn-sm" onclick="FilesModule._currentFolder='root';FilesModule.loadDriveFiles()">🏠 Racine</button>
                            <button class="btn btn-secondary btn-sm" onclick="FilesModule.loadDriveFiles()">🔄 Rafraîchir</button>
                        </div>
                    </div>
                    <div id="gdrive-files">
                        <div style="text-align:center;padding:20px;color:var(--text-muted);">⏳ Chargement...</div>
                    </div>
                </div>
            </div>
        `;

        await this.checkGDriveStatus();
    },

    async checkGDriveStatus() {
        const statusEl = document.getElementById('gdrive-status');
        if (!statusEl) return;

        const r = await Auth.apiCall('/api/gdrive/status');
        if (!r || !r.ok) {
            statusEl.innerHTML = `
                <div style="display:flex;align-items:center;gap:16px;">
                    <span style="font-size:32px;">☁️</span>
                    <div style="flex:1;">
                        <div style="font-weight:700;font-size:15px;">Google Drive</div>
                        <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">Impossible de vérifier le statut</div>
                    </div>
                </div>`;
            return;
        }

        const status = await r.json();
        this._gdriveStatus = status;

        const statusIcons = { connected: '🟢', not_installed: '🔴', no_credentials: '🟡', not_authenticated: '🟡', error: '🔴' };

        statusEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:16px;">
                <span style="font-size:32px;">${statusIcons[status.status] || '⚪'}</span>
                <div style="flex:1;">
                    <div style="font-weight:700;font-size:15px;">Google Drive ${status.connected ? '— Connecté' : ''}</div>
                    <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">${status.message}</div>
                    ${status.email ? `<div style="font-size:12px;color:var(--accent-blue);margin-top:2px;">📧 ${status.email}</div>` : ''}
                </div>
                ${!status.connected && status.status === 'not_authenticated' ? `
                    <button class="btn btn-primary" onclick="FilesModule.connectGDrive()">🔗 Connecter</button>
                ` : ''}
                ${status.status === 'not_installed' ? `
                    <div style="font-size:11px;color:var(--text-muted);max-width:200px;">
                        pip install google-api-python-client google-auth-oauthlib
                    </div>
                ` : ''}
            </div>`;

        if (status.connected) {
            document.getElementById('gdrive-browser').style.display = 'block';
            await this.loadDriveFiles();
        }
    },

    async connectGDrive() {
        const r = await Auth.apiCall('/api/gdrive/connect', { method: 'POST' });
        if (r && r.ok) {
            alert('✅ Google Drive connecté !');
            await this.checkGDriveStatus();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            alert(`❌ ${err.detail || 'Erreur de connexion'}`);
        }
    },

    async loadDriveFiles() {
        const filesEl = document.getElementById('gdrive-files');
        if (!filesEl) return;

        filesEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">⏳ Chargement...</div>';

        const r = await Auth.apiCall(`/api/gdrive/files?folder_id=${this._currentFolder}`);
        if (!r || !r.ok) {
            filesEl.innerHTML = '<div style="color:#ef4444;padding:12px;">❌ Erreur</div>';
            return;
        }

        const data = await r.json();
        const files = data.files || [];

        if (files.length === 0) {
            filesEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">📂 Dossier vide</div>';
            return;
        }

        const typeIcons = { folder: '📁', file: '📄' };

        filesEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:2px;">
                ${files.map(f => `
                    <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:6px;cursor:pointer;transition:all .1s;"
                        onmouseover="this.style.background='var(--bg-tertiary)'"
                        onmouseout="this.style.background='transparent'"
                        onclick="${f.type === 'folder' ? `FilesModule._currentFolder='${f.id}';FilesModule.loadDriveFiles()` : ''}">
                        <span style="font-size:18px;">${typeIcons[f.type] || '📄'}</span>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${f.name}</div>
                            <div style="font-size:11px;color:var(--text-muted);">
                                ${f.size > 0 ? (f.size > 1048576 ? Math.round(f.size/1048576) + ' Mo' : Math.round(f.size/1024) + ' Ko') : ''}
                                ${f.modified ? ' · ' + new Date(f.modified).toLocaleDateString('fr-FR') : ''}
                            </div>
                        </div>
                        ${f.type === 'file' ? `
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();FilesModule.downloadFile('${f.id}','${f.name}')" style="font-size:11px;padding:2px 8px;">⬇️</button>
                        ` : ''}
                    </div>
                `).join('')}
            </div>`;
    },

    async downloadFile(fileId, fileName) {
        const r = await Auth.apiCall('/api/gdrive/download', {
            method: 'POST',
            body: JSON.stringify({ file_id: fileId })
        });
        if (r && r.ok) {
            const data = await r.json();
            alert(`✅ ${data.message}`);
        } else {
            alert('❌ Erreur de téléchargement');
        }
    },
};
