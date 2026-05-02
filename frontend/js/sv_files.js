/**
 * SvFiles — Explorateur de fichiers style Minestrator.
 * Navigation, édition, création, suppression de fichiers.
 */
const SvFiles = {
    _serverId: null,
    _currentPath: '/',
    _editing: null,

    render(serverId) {
        this._serverId = serverId;
        this._currentPath = '/';
        this._editing = null;
        setTimeout(() => this._loadDir(), 50);
        return `
        <h2>📁 Fichiers</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">Parcourez, éditez et gérez les fichiers de votre serveur</p>
        <div id="sv-files-quickaccess" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
            ${['server.properties','spigot.yml','bukkit.yml','paper-global.yml'].map(f =>
                `<button class="btn btn-secondary btn-sm" onclick="SvFiles._openFile('/${f}')" style="font-size:11px;">${f} <span style="font-size:9px;padding:1px 4px;background:var(--accent-blue);color:#fff;border-radius:3px;">Builder</span></button>`
            ).join('')}
        </div>
        <div id="sv-files-toolbar" style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">
            <div id="sv-files-breadcrumb" style="flex:1;font-size:13px;"></div>
            <button class="btn btn-secondary btn-sm" onclick="SvFiles._promptNewFile()">📄 Nouveau fichier</button>
            <button class="btn btn-secondary btn-sm" onclick="SvFiles._promptMkdir()">📁 Nouveau dossier</button>
        </div>
        <div id="sv-files-content"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>`;
    },

    _breadcrumb() {
        const parts = this._currentPath.split('/').filter(Boolean);
        let html = `<span style="cursor:pointer;color:var(--accent-blue);" onclick="SvFiles._navigate('/')">🏠 Home</span>`;
        let path = '';
        for (const part of parts) {
            path += '/' + part;
            const p = path;
            html += ` <span style="color:var(--text-muted);">/</span> <span style="cursor:pointer;color:var(--accent-blue);" onclick="SvFiles._navigate('${p}')">${part}</span>`;
        }
        return html;
    },

    async _loadDir() {
        const el = document.getElementById('sv-files-content');
        const bc = document.getElementById('sv-files-breadcrumb');
        if (!el) return;
        if (bc) bc.innerHTML = this._breadcrumb();
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Chargement...</div>';

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files?path=${encodeURIComponent(this._currentPath)}`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Erreur</div>'; return; }
        const data = await r.json();
        const files = data.files || [];

        if (files.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">Dossier vide</div>';
            return;
        }

        let html = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="border-bottom:2px solid var(--border-color);text-align:left;">
                <th style="padding:8px;">Nom</th>
                <th style="padding:8px;width:100px;">Taille</th>
                <th style="padding:8px;width:150px;">Modifié</th>
                <th style="padding:8px;width:60px;"></th>
            </tr></thead><tbody>`;

        // Bouton "dossier parent" si on n'est pas à la racine
        if (this._currentPath !== '/') {
            const parent = this._currentPath.split('/').slice(0, -1).join('/') || '/';
            html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border-color);" onclick="SvFiles._navigate('${parent}')">
                <td style="padding:8px;">⬆️ <strong>..</strong></td><td></td><td></td><td></td></tr>`;
        }

        for (const f of files) {
            const fullPath = (this._currentPath === '/' ? '' : this._currentPath) + '/' + f.name;
            const size = f.is_dir ? '—' : this._formatSize(f.size);
            const icon = f.is_dir ? '📁' : this._fileIcon(f.name);

            if (f.is_dir) {
                html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border-color);" onmouseover="this.style.background='rgba(59,130,246,0.05)'" onmouseout="this.style.background='transparent'" onclick="SvFiles._navigate('${fullPath}')">
                    <td style="padding:8px;">${icon} <strong>${f.name}</strong></td>
                    <td style="padding:8px;color:var(--text-muted);">${size}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;">${f.modified}</td>
                    <td style="padding:8px;"><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvFiles._delete('${fullPath}')">🗑️</button></td>
                </tr>`;
            } else {
                html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border-color);" onmouseover="this.style.background='rgba(59,130,246,0.05)'" onmouseout="this.style.background='transparent'" onclick="SvFiles._openFile('${fullPath}')">
                    <td style="padding:8px;">${icon} ${f.name}</td>
                    <td style="padding:8px;color:var(--text-muted);">${size}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;">${f.modified}</td>
                    <td style="padding:8px;"><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvFiles._delete('${fullPath}')">🗑️</button></td>
                </tr>`;
            }
        }
        html += '</tbody></table>';
        el.innerHTML = html;
    },

    _navigate(path) {
        this._currentPath = path;
        this._editing = null;
        this._loadDir();
    },

    async _openFile(path) {
        const el = document.getElementById('sv-files-content');
        const bc = document.getElementById('sv-files-breadcrumb');
        if (!el) return;
        this._editing = path;
        if (bc) bc.innerHTML = this._breadcrumb() + ` <span style="color:var(--text-muted);">/</span> <span style="color:var(--accent-green);">✏️ ${path.split('/').pop()}</span>`;
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Chargement du fichier...</div>';

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files/content?path=${encodeURIComponent(path)}`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Impossible de lire ce fichier</div>'; return; }
        const data = await r.json();

        el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div>
                <button class="btn btn-secondary btn-sm" onclick="SvFiles._navigate('${this._currentPath}')">← Retour</button>
                <span style="font-weight:600;margin-left:8px;">${data.filename}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <span id="sv-file-msg" style="font-size:12px;"></span>
                <button class="btn btn-primary btn-sm" onclick="SvFiles._saveFile('${path}')">💾 Sauvegarder</button>
            </div>
        </div>
        <textarea id="sv-file-editor" style="width:100%;height:calc(100vh - 300px);min-height:400px;font-family:'Fira Code',monospace;font-size:12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:8px;padding:12px;resize:vertical;line-height:1.6;tab-size:4;">${this._escapeHtml(data.content)}</textarea>`;
    },

    async _saveFile(path) {
        const textarea = document.getElementById('sv-file-editor');
        const msg = document.getElementById('sv-file-msg');
        if (!textarea) return;
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳...'; }

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files/content`, {
            method: 'PUT', body: JSON.stringify({path, content: textarea.value})
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegardé !'; }
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    async _delete(path) {
        if (!confirm(`Supprimer ${path} ?`)) return;
        await Auth.apiCall(`/api/servers/${this._serverId}/files?path=${encodeURIComponent(path)}`, {method: 'DELETE'});
        this._loadDir();
    },

    _promptMkdir() {
        const name = prompt('Nom du nouveau dossier :');
        if (!name) return;
        const path = (this._currentPath === '/' ? '' : this._currentPath) + '/' + name;
        Auth.apiCall(`/api/servers/${this._serverId}/files/mkdir`, {
            method: 'POST', body: JSON.stringify({path})
        }).then(() => this._loadDir());
    },

    _promptNewFile() {
        const name = prompt('Nom du nouveau fichier :');
        if (!name) return;
        const path = (this._currentPath === '/' ? '' : this._currentPath) + '/' + name;
        Auth.apiCall(`/api/servers/${this._serverId}/files/content`, {
            method: 'PUT', body: JSON.stringify({path, content: ''})
        }).then(() => this._loadDir());
    },

    _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' o';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
        return (bytes / 1048576).toFixed(1) + ' Mo';
    },

    _fileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const icons = {yml:'📝',yaml:'📝',properties:'⚙️',json:'📋',txt:'📄',log:'📜',jar:'☕',zip:'📦',gz:'📦',tar:'📦'};
        return icons[ext] || '📄';
    },

    _escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },
};
