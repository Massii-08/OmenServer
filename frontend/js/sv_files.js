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
        <h2>${Lang.t('sv.files.title')}</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">${Lang.t('sv.files.desc')}</p>
        <div id="sv-files-quickaccess" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
            ${['server.properties','spigot.yml','bukkit.yml','paper-global.yml','ops.json','whitelist.json'].map(f =>
                `<button class="btn btn-secondary btn-sm" onclick="SvFiles._openFile('/${f}')" style="font-size:11px;">${this._fileIcon(f)} ${f}</button>`
            ).join('')}
        </div>
        <div id="sv-files-toolbar" style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">
            <div id="sv-files-breadcrumb" style="flex:1;font-size:13px;"></div>
            <button class="btn btn-primary btn-sm" onclick="document.getElementById('sv-file-upload').click()">${Lang.t('sv.files.upload')}</button>
            <input type="file" id="sv-file-upload" multiple style="display:none;" onchange="SvFiles._uploadFiles(this.files)" />
            <button class="btn btn-secondary btn-sm" onclick="SvFiles._promptNewFile()">${Lang.t('sv.files.new_file')}</button>
            <button class="btn btn-secondary btn-sm" onclick="SvFiles._promptMkdir()">${Lang.t('sv.files.new_folder')}</button>
        </div>
        <div id="sv-upload-progress" style="display:none;margin-bottom:10px;"></div>
        <div id="sv-files-content"><div style="color:var(--text-muted)">⏳ ${Lang.t('common.loading')}</div></div>`;
    },

    _breadcrumb() {
        const parts = this._currentPath.split('/').filter(Boolean);
        let html = `<span style="cursor:pointer;color:var(--info);" onclick="SvFiles._navigate('/')">Home</span>`;
        let path = '';
        for (const part of parts) {
            path += '/' + part;
            const p = path;
            html += ` <span style="color:var(--text-muted);">/</span> <span style="cursor:pointer;color:var(--info);" onclick="SvFiles._navigate('${p}')">${part}</span>`;
        }
        return html;
    },

    async _loadDir() {
        const el = document.getElementById('sv-files-content');
        const bc = document.getElementById('sv-files-breadcrumb');
        if (!el) return;
        if (bc) bc.innerHTML = this._breadcrumb();
        el.innerHTML = `<div style="color:var(--text-muted)">⏳ ${Lang.t('common.loading')}</div>`;

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files?path=${encodeURIComponent(this._currentPath)}`);
        if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
        const data = await r.json();
        const files = data.files || [];

        if (files.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('sv.files.empty')}</div>`;
            return;
        }

        let html = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="border-bottom:2px solid var(--border);text-align:left;">
                <th style="padding:8px;">${Lang.t('sv.files.name')}</th>
                <th style="padding:8px;width:100px;">${Lang.t('sv.files.size')}</th>
                <th style="padding:8px;width:150px;">${Lang.t('sv.files.modified')}</th>
                <th style="padding:8px;width:80px;"></th>
            </tr></thead><tbody>`;

        if (this._currentPath !== '/') {
            const parent = this._currentPath.split('/').slice(0, -1).join('/') || '/';
            html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border);" onclick="SvFiles._navigate('${parent}')">
                <td style="padding:8px;">⬆<strong>..</strong></td><td></td><td></td><td></td></tr>`;
        }

        for (const f of files) {
            const fullPath = (this._currentPath === '/' ? '' : this._currentPath) + '/' + f.name;
            const size = f.is_dir ? '—' : this._formatSize(f.size);
            const icon = f.is_dir ? '' : this._fileIcon(f.name);
            // safePath/safeName : escape JS-string (\, ') PUIS HTML-attr (esc couvre " < > & ')
            // → ni le contexte JS ni l'attribut double-quote ne peuvent être cassés par un nom hostile.
            const safePath = esc(fullPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
            const safeName = esc(f.name.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));

            if (f.is_dir) {
                html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border);" onmouseover="this.style.background='rgba(96,165,250,0.05)'" onmouseout="this.style.background='transparent'" onclick="SvFiles._navigate('${safePath}')">
                    <td style="padding:8px;">${icon} <strong>${esc(f.name)}</strong></td>
                    <td style="padding:8px;color:var(--text-muted);">${size}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;">${esc(f.modified)}</td>
                    <td style="padding:8px;text-align:right;">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();SvFiles._rename('${safePath}','${safeName}')" title="${Lang.t('sv.files.rename')}">${Lang.t('sv.files.rename')}</button>
                        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvFiles._delete('${safePath}')" title="${Lang.t('common.delete')}">${Lang.t('common.delete')}</button>
                    </td>
                </tr>`;
            } else {
                const editable = this._isEditable(f.name);
                html += `<tr style="cursor:pointer;border-bottom:1px solid var(--border);" onmouseover="this.style.background='rgba(96,165,250,0.05)'" onmouseout="this.style.background='transparent'" onclick="${editable ? `SvFiles._openFile('${safePath}')` : ''}">
                    <td style="padding:8px;">${icon} ${esc(f.name)}</td>
                    <td style="padding:8px;color:var(--text-muted);">${size}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;">${esc(f.modified)}</td>
                    <td style="padding:8px;text-align:right;">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();SvFiles._rename('${safePath}','${safeName}')" title="${Lang.t('sv.files.rename')}">${Lang.t('sv.files.rename')}</button>
                        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvFiles._delete('${safePath}')" title="${Lang.t('common.delete')}">${Lang.t('common.delete')}</button>
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
        if (bc) bc.innerHTML = this._breadcrumb() + ` <span style="color:var(--text-muted);">/</span> <span style="color:var(--accent);">${esc(fileName)}</span>`;
        el.innerHTML = `<div style="color:var(--text-muted)">${Lang.t('sv.files.loading_file')}</div>`;

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files/content?path=${encodeURIComponent(path)}`);
        if (!r || !r.ok) {
            el.innerHTML = `<div style="color:var(--danger)">${Lang.t('sv.files.cant_read')}</div><br><button class="btn btn-secondary btn-sm" onclick="SvFiles._navigate(SvFiles._currentPath)">${Lang.t('sv.files.back')}</button>`;
            return;
        }
        const data = await r.json();
        const lineCount = (data.content || '').split('\n').length;
        const safePath = path.replace(/'/g, "\\'");

        el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
                <button class="btn btn-secondary btn-sm" onclick="SvFiles._navigate('${this._currentPath}')">${Lang.t('sv.files.back')}</button>
                <span style="font-weight:600;font-size:14px;">${this._fileIcon(fileName)} ${esc(data.filename)}</span>
                <span style="font-size:11px;color:var(--text-muted);">${lineCount} ${Lang.t('sv.files.lines')}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <span id="sv-file-msg" style="font-size:12px;"></span>
                <span style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.files.save_hint')}</span>
                <button class="btn btn-primary btn-sm" onclick="SvFiles._saveFile('${safePath}')">${Lang.t('sv.files.save')}</button>
            </div>
        </div>
        <div style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
            <div style="display:flex;">
                <div id="sv-file-lines" style="width:45px;background:rgba(0,0,0,0.2);padding:12px 8px;text-align:right;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:var(--text-muted);user-select:none;overflow:hidden;">
                    ${Array.from({length: lineCount}, (_, i) => i + 1).join('<br>')}
                </div>
                <textarea id="sv-file-editor" spellcheck="false" style="flex:1;height:calc(100vh - 320px);min-height:400px;font-family:'Fira Code','Courier New',monospace;font-size:12px;background:var(--bg-elev-1);color:var(--text);border:none;padding:12px;resize:none;line-height:1.6;tab-size:4;outline:none;white-space:pre;overflow-wrap:normal;overflow-x:auto;">${this._escapeHtml(data.content)}</textarea>
            </div>
        </div>`;

        const editor = document.getElementById('sv-file-editor');
        if (editor) {
            editor.addEventListener('keydown', (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = editor.selectionStart;
                    const end = editor.selectionEnd;
                    editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
                    editor.selectionStart = editor.selectionEnd = start + 4;
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    SvFiles._saveFile(path);
                }
            });
            editor.addEventListener('scroll', () => {
                const lines = document.getElementById('sv-file-lines');
                if (lines) lines.scrollTop = editor.scrollTop;
            });
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
        if (msg) { msg.style.color = 'var(--info)'; msg.textContent = Lang.t('sv.files.saving'); }

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/files/content`, {
            method: 'PUT', body: JSON.stringify({path, content: textarea.value})
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = Lang.t('sv.files.saved'); }
            setTimeout(() => { if (msg) msg.textContent = ''; }, 2000);
        } else {
            if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${Lang.t('common.error')}`; }
        }
    },

    async _delete(path) {
        if (!confirm(`${Lang.t('sv.files.delete_confirm')} ${path.split('/').pop()} ?`)) return;
        await Auth.apiCall(`/api/servers/${this._serverId}/files?path=${encodeURIComponent(path)}`, {method: 'DELETE'});
        this._loadDir();
    },

    _rename(path, oldName) {
        const newName = prompt(Lang.t('sv.files.rename_prompt'), oldName);
        if (!newName || newName === oldName) return;
        const dir = path.substring(0, path.lastIndexOf('/'));
        const newPath = dir + '/' + newName;
        Auth.apiCall(`/api/servers/${this._serverId}/files/rename`, {
            method: 'POST', body: JSON.stringify({old_path: path, new_path: newPath})
        }).then(() => this._loadDir());
    },

    _promptMkdir() {
        const name = prompt(Lang.t('sv.files.new_folder_prompt'));
        if (!name) return;
        const path = (this._currentPath === '/' ? '' : this._currentPath) + '/' + name;
        Auth.apiCall(`/api/servers/${this._serverId}/files/mkdir`, {
            method: 'POST', body: JSON.stringify({path})
        }).then(() => this._loadDir());
    },

    _promptNewFile() {
        const name = prompt(Lang.t('sv.files.new_file_prompt'));
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
        const icons = {yml:'',yaml:'',properties:'',json:'',txt:'',log:'',jar:'',zip:'',gz:'',tar:'',sh:'',bat:'',xml:'',toml:'',cfg:'',conf:'',ini:'',md:'',csv:'',png:'',jpg:'',gif:''};
        return icons[ext] || '';
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
                prog.innerHTML = `<div style="padding:8px 12px;background:var(--bg-elev-1);border-radius:6px;font-size:12px;">
                    ⏳ Upload ${i+1}/${fileList.length} : <strong>${esc(f.name)}</strong> (${(f.size/1024/1024).toFixed(2)} Mo)...
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

        const inp = document.getElementById('sv-file-upload');
        if (inp) inp.value = '';

        if (prog) {
            const color = fail === 0 ? 'var(--accent)' : 'var(--danger)';
            prog.innerHTML = `<div style="padding:8px 12px;background:var(--bg-elev-1);border-radius:6px;font-size:12px;color:${color};">
                ${fail === 0 ? '' : ''} ${success} ${Lang.t('sv.files.uploaded')}${fail > 0 ? `, ${fail} ${Lang.t('sv.files.upload_errors')}` : ''}
            </div>`;
            setTimeout(() => { prog.style.display = 'none'; }, 4000);
        }

        this._loadDir();
    },
};
