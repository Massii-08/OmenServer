/**
 * SvFiles — Explorateur de fichiers style Minestrator.
 * Navigation, édition avancée, création, suppression de fichiers.
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
            ${['server.properties','spigot.yml','bukkit.yml','paper-global.yml','ops.json','whitelist.json'].map(f =>
                `<button class="btn btn-secondary btn-sm" onclick="SvFiles._openFile('/${f}')" style="font-size:11px;">${this._fileIcon(f)} ${f}</button>`
            ).join('')}
        </div>
        <div id="sv-files-toolbar" style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">
            <div id="sv-files-breadcrumb" style="flex:1;font-size:13px;"></div>
            <button class="btn btn-primary btn-sm" onclick="document.getElementById('sv-file-upload').click()">📤 Uploader</button>
            <input type="file" id="sv-file-upload" multiple style="display:none;" onchange="SvFiles._uploadFiles(this.files)" />
            <button class="btn btn-secondary btn-sm" onclick="SvFiles._promptNewFile()">📄 Nouveau fichier</button>
            <button class="btn btn-secondary btn-sm" onclick="SvFiles._promptMkdir()">📁 Nouveau dossier</button>
        </div>
        <div id="sv-upload-progress" style="display:none;margin-bottom:10px;"></div>
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
                <th style="padding:8px;width:80px;"></th>
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
            const safePath = fullPath.replace(/'/g, "\\'");

            if (f.is_dir) {
                html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border-color);" onmouseover="this.style.background='rgba(59,130,246,0.05)'" onmouseout="this.style.background='transparent'" onclick="SvFiles._navigate('${safePath}')">
                    <td style="padding:8px;">${icon} <strong>${f.name}</strong></td>
                    <td style="padding:8px;color:var(--text-muted);">${size}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;">${f.modified}</td>
                    <td style="padding:8px;text-align:right;">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();SvFiles._rename('${safePath}','${f.name}')" title="Renommer">✏️</button>
                        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvFiles._delete('${safePath}')" title="Supprimer">🗑️</button>
                    </td>
                </tr>`;
            } else {
                const editable = this._isEditable(f.name);
                html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border-color);" onmouseover="this.style.background='rgba(59,130,246,0.05)'" onmouseout="this.style.background='transparent'" onclick="${editable ? `SvFiles._openFile('${safePath}')` : ''}">
                    <td style="padding:8px;">${icon} ${f.name}</td>
                    <td style="padding:8px;color:var(--text-muted);">${size}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;">${f.modified}</td>
                    <td style="padding:8px;text-align:right;">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();SvFiles._rename('${safePath}','${f.name}')" title="Renommer">✏️</button>
                        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvFiles._delete('${safePath}')" title="Supprimer">🗑️</button>
                    </td>
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

    _isEditable(name) {
        const ext = name.split('.').pop().toLowerCase();
        return ['yml','yaml','properties','json','txt','log','cfg','conf','ini','toml','xml','sh','bat','md','csv','env'].includes(ext);
    },

    async _openFile(path) {
        const el = document.getElementById('sv-files-content');
        const bc = document.getElementById('sv-files-breadcrumb');
        if (!el) return;
        this._editing = path;
        const fileName = path.split('/').pop();
        if (bc) bc.innerHTML = this._breadcrumb() + ` <span style="color:var(--text-muted);">/</span> <span style="color:var(--accent-green);">✏️ ${fileName}</span>`;
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Chargement du fichier...</div>';

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files/content?path=${encodeURIComponent(path)}`);
        if (!r || !r.ok) {
            el.innerHTML = '<div style="color:#e74c3c">❌ Impossible de lire ce fichier (binaire ou trop volumineux)</div><br><button class="btn btn-secondary btn-sm" onclick="SvFiles._navigate(SvFiles._currentPath)">← Retour</button>';
            return;
        }
        const data = await r.json();
        const lineCount = (data.content || '').split('\n').length;
        const safePath = path.replace(/'/g, "\\'");

        el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
                <button class="btn btn-secondary btn-sm" onclick="SvFiles._navigate('${this._currentPath}')">← Retour</button>
                <span style="font-weight:600;font-size:14px;">${this._fileIcon(fileName)} ${data.filename}</span>
                <span style="font-size:11px;color:var(--text-muted);">${lineCount} lignes</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <span id="sv-file-msg" style="font-size:12px;"></span>
                <span style="font-size:11px;color:var(--text-muted);">Ctrl+S pour sauvegarder</span>
                <button class="btn btn-primary btn-sm" onclick="SvFiles._saveFile('${safePath}')">💾 Sauvegarder</button>
            </div>
        </div>
        <div style="position:relative;border:1px solid var(--border-color);border-radius:8px;overflow:hidden;">
            <div style="display:flex;">
                <div id="sv-file-lines" style="width:45px;background:rgba(0,0,0,0.2);padding:12px 8px;text-align:right;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:var(--text-muted);user-select:none;overflow:hidden;">
                    ${Array.from({length: lineCount}, (_, i) => i + 1).join('<br>')}
                </div>
                <textarea id="sv-file-editor" spellcheck="false" style="flex:1;height:calc(100vh - 320px);min-height:400px;font-family:'Fira Code','Courier New',monospace;font-size:12px;background:var(--bg-secondary);color:var(--text-primary);border:none;padding:12px;resize:none;line-height:1.6;tab-size:4;outline:none;white-space:pre;overflow-wrap:normal;overflow-x:auto;">${this._escapeHtml(data.content)}</textarea>
            </div>
        </div>`;

        // Bind events
        const editor = document.getElementById('sv-file-editor');
        if (editor) {
            // Tab support
            editor.addEventListener('keydown', (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = editor.selectionStart;
                    const end = editor.selectionEnd;
                    editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
                    editor.selectionStart = editor.selectionEnd = start + 4;
                }
                // Ctrl+S save
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    SvFiles._saveFile(path);
                }
            });
            // Sync line numbers on scroll
            editor.addEventListener('scroll', () => {
                const lines = document.getElementById('sv-file-lines');
                if (lines) lines.scrollTop = editor.scrollTop;
            });
            // Update line numbers on input
            editor.addEventListener('input', () => {
                const lines = document.getElementById('sv-file-lines');
                if (lines) {
                    const count = editor.value.split('\n').length;
                    lines.innerHTML = Array.from({length: count}, (_, i) => i + 1).join('<br>');
                }
            });
        }
    },

    async _saveFile(path) {
        const textarea = document.getElementById('sv-file-editor');
        const msg = document.getElementById('sv-file-msg');
        if (!textarea) return;
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Sauvegarde...'; }

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files/content`, {
            method: 'PUT', body: JSON.stringify({path, content: textarea.value})
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegardé !'; }
            setTimeout(() => { if (msg) msg.textContent = ''; }, 2000);
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    async _delete(path) {
        if (!confirm(`Supprimer ${path.split('/').pop()} ?`)) return;
        await Auth.apiCall(`/api/servers/${this._serverId}/files?path=${encodeURIComponent(path)}`, {method: 'DELETE'});
        this._loadDir();
    },

    _rename(path, oldName) {
        const newName = prompt('Nouveau nom :', oldName);
        if (!newName || newName === oldName) return;
        const dir = path.substring(0, path.lastIndexOf('/'));
        const newPath = dir + '/' + newName;
        Auth.apiCall(`/api/servers/${this._serverId}/files/rename`, {
            method: 'POST', body: JSON.stringify({old_path: path, new_path: newPath})
        }).then(() => this._loadDir());
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
        const icons = {yml:'📝',yaml:'📝',properties:'⚙️',json:'📋',txt:'📄',log:'📜',jar:'☕',zip:'📦',gz:'📦',tar:'📦',sh:'🔧',bat:'🔧',xml:'📋',toml:'📝',cfg:'⚙️',conf:'⚙️',ini:'⚙️',md:'📖',csv:'📊',png:'🖼️',jpg:'🖼️',gif:'🖼️'};
        return icons[ext] || '📄';
    },

    _escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },

    async _uploadFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        const prog = document.getElementById('sv-upload-progress');
        if (prog) { prog.style.display = 'block'; }

        let success = 0, fail = 0;
        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            if (prog) {
                prog.innerHTML = `<div style="padding:8px 12px;background:var(--bg-secondary);border-radius:6px;font-size:12px;">
                    ⏳ Upload ${i+1}/${fileList.length} : <strong>${f.name}</strong> (${(f.size/1024/1024).toFixed(2)} Mo)...
                </div>`;
            }

            const formData = new FormData();
            formData.append('file', f);
            formData.append('path', this._currentPath);

            try {
                const token = Auth.getToken();
                const r = await fetch(`/api/servers/${this._serverId}/files/upload`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData,
                });
                if (r.ok) success++; else fail++;
            } catch { fail++; }
        }

        // Reset file input
        const inp = document.getElementById('sv-file-upload');
        if (inp) inp.value = '';

        if (prog) {
            const color = fail === 0 ? 'var(--accent-green)' : '#e74c3c';
            prog.innerHTML = `<div style="padding:8px 12px;background:var(--bg-secondary);border-radius:6px;font-size:12px;color:${color};">
                ${fail === 0 ? '✅' : '⚠️'} ${success} fichier(s) uploadé(s)${fail > 0 ? `, ${fail} erreur(s)` : ''}
            </div>`;
            setTimeout(() => { prog.style.display = 'none'; }, 4000);
        }

        this._loadDir();
    },
};
