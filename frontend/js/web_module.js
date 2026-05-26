/**
 * WebModule — Interface du Module Serveur Web.
 *
 * Permet de créer, gérer et monitorer des sites web
 * hébergés via Docker (Nginx, Node.js, PHP, Python).
 */
const WebModule = {
    _sites: [],
    _refreshInterval: null,

    async render(container) {
        console.log('[WebModule] render() called');
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                <div>
                    <h1 style="margin:0;">${Lang.t('web.title')}</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">${Lang.t('web.subtitle')}</p>
                </div>
                <div style="display:flex;gap:8px;">
                    ${(() =>{ const u = Auth.getUser(); const canCreate = u && (u.is_admin || u.role === 'developer'); return canCreate ? `<button class="btn btn-primary" onclick="WebModule.showCreateForm()">${Lang.t('web.new_site')}</button>` : ''; })()}
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">${Lang.t('net.back_hub')}</button>
                </div>
            </div>

            <div id="web-create-form" style="display:none;margin-bottom:20px;"></div>
            <div id="web-sites-grid"><div style="text-align:center;padding:20px;color:var(--text-muted);">⏳ ${Lang.t('common.loading')}</div></div>
            <div id="web-site-detail" style="display:none;margin-top:20px;"></div>
        `;

        await this.loadSites();
        this._refreshInterval = setInterval(() =>this.loadSites(), 6000);
    },

    unload() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
        }
    },

    async loadSites() {
        const r = await Auth.apiCall('/api/websites');
        if (!r || !r.ok) return;
        this._sites = await r.json();
        this._renderGrid();
    },

    _renderGrid() {
        const grid = document.getElementById('web-sites-grid');
        if (!grid) return;

        const typeIcons = { static: '', node: '', php: '', python: '' };
        const statusColors = { running: 'var(--accent)', stopped: '#6b7280', error: 'var(--danger)' };
        const statusLabels = { running: Lang.t('web.status_running'), stopped: Lang.t('web.status_stopped'), error: Lang.t('web.status_error') };

        if (this._sites.length === 0) {
            grid.innerHTML = `
                <div style="text-align:center;padding:60px;">
                    <div style="font-size:48px;margin-bottom:12px;"></div>
                    <div style="color:var(--text-muted);font-size:15px;">${Lang.t('web.no_sites')}</div>
                    <div style="color:var(--text-muted);font-size:12px;margin-top:4px;">${Lang.t('web.no_sites_hint')}</div>
                </div>`;
            return;
        }

        grid.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;">
                ${this._sites.map(s =>`
                    <div class="card" style="cursor:pointer;transition:all .15s;"
                        onmouseover="this.style.transform='translateY(-2px)'"
                        onmouseout="this.style.transform=''">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <span style="font-size:28px;">${typeIcons[s.site_type] || ''}</span>
                                <div>
                                    <div style="font-weight:700;font-size:14px;">${s.name}</div>
                                    <div style="font-size:11px;color:var(--text-muted);">${s.type_label || s.site_type} · Port ${s.port}</div>
                                </div>
                            </div>
                            <span style="font-size:11px;padding:2px 8px;border-radius:4px;color:${statusColors[s.status]};background:${statusColors[s.status]}15;font-weight:600;">
                                ${statusLabels[s.status] || s.status}
                            </span>
                        </div>
                        ${s.description ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${s.description}</div>` : ''}
                        ${s.status === 'running' && s.url ? `
                            <div style="padding:8px;background:var(--bg-elev-3);border-radius:6px;border:1px solid var(--border);margin-bottom:12px;">
                                <a href="${s.url}" target="_blank" style="color:var(--info);font-size:12px;text-decoration:none;font-family:monospace;">
                                    ${s.url} ↗
                                </a>
                            </div>
                        ` : ''}
                        <div style="display:flex;gap:6px;">
                            ${s.status === 'running'
                                ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();WebModule.stopSite(${s.id})" style="font-size:11px;padding:4px 12px;">Stop</button>`
                                : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();WebModule.startSite(${s.id})" style="font-size:11px;padding:4px 12px;">Start</button>`
                            }
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();WebModule.showLogs(${s.id})" style="font-size:11px;padding:4px 12px;">${Lang.t('web.logs_title')}</button>
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();WebModule.deleteSite(${s.id})" style="font-size:11px;padding:4px 8px;color:var(--danger);"></button>
                        </div>
                    </div>
                `).join('')}
            </div>`;
    },

    showCreateForm() {
        const form = document.getElementById('web-create-form');
        if (!form) return;
        form.style.display = 'block';
        form.innerHTML = `
            <div class="card">
                <h3 style="margin:0 0 16px;">${Lang.t('web.create_title')}</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                    <div>
                        <label class="form-label">${Lang.t('web.site_name')}</label>
                        <input id="web-name" class="form-input" placeholder="Mon site" />
                    </div>
                    <div>
                        <label class="form-label">${Lang.t('web.site_type')}</label>
                        <select id="web-type" class="form-input">
                            <option value="static">${Lang.t('web.static')}</option>
                            <option value="node">${Lang.t('web.node')}</option>
                            <option value="php">${Lang.t('web.php')}</option>
                            <option value="python">${Lang.t('web.python')}</option>
                        </select>
                    </div>
                    <div>
                        <label class="form-label">${Lang.t('web.description')}</label>
                        <input id="web-desc" class="form-input" placeholder="Mon projet..." />
                    </div>
                </div>
                <div style="margin-bottom:12px;">
                    <label class="form-label">${Lang.t('web.git_url')}</label>
                    <input id="web-git" class="form-input" placeholder="https://github.com/user/repo.git" style="font-family:monospace;font-size:12px;" />
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-primary" onclick="WebModule.createSite()">${Lang.t('common.confirm')}</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('web-create-form').style.display='none'">${Lang.t('common.cancel')}</button>
                    <span id="web-create-msg" style="font-size:13px;"></span>
                </div>
            </div>`;
    },

    async createSite() {
        const name = document.getElementById('web-name')?.value?.trim();
        const type = document.getElementById('web-type')?.value || 'static';
        const port = parseInt(document.getElementById('web-port')?.value) || 3000;
        const desc = document.getElementById('web-desc')?.value?.trim() || '';
        const gitUrl = document.getElementById('web-git')?.value?.trim() || '';
        const msg = document.getElementById('web-create-msg');

        if (!name) { if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = Lang.t('web.name_required'); } return; }

        if (msg) { msg.style.color = 'var(--info)'; msg.textContent = gitUrl ? Lang.t('web.cloning') : Lang.t('web.creating'); }

        const r = await Auth.apiCall('/api/websites', {
            method: 'POST',
            body: JSON.stringify({ name, site_type: type, description: desc, git_url: gitUrl })
        });

        if (r && r.ok) {
            document.getElementById('web-create-form').style.display = 'none';
            if (typeof Toast !== 'undefined') Toast.success(`${name} `);
            await this.loadSites();
        } else {
            const err = r ? await r.json().catch(() =>({})) : {};
            if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
        }
    },

    async startSite(id) {
        const r = await Auth.apiCall(`/api/websites/${id}/start`, { method: 'POST' });
        if (r && r.ok) await this.loadSites();
        else { const err = r ? await r.json().catch(() =>({})) : {}; if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error')); else alert(`${err.detail || Lang.t('common.error')}`); }
    },

    async stopSite(id) {
        const r = await Auth.apiCall(`/api/websites/${id}/stop`, { method: 'POST' });
        if (r && r.ok) await this.loadSites();
    },

    async deleteSite(id) {
        if (!confirm(Lang.t('web.delete_confirm'))) return;
        const r = await Auth.apiCall(`/api/websites/${id}`, { method: 'DELETE' });
        if (r && r.ok) {
            document.getElementById('web-site-detail').style.display = 'none';
            await this.loadSites();
        }
    },

    async showLogs(id) {
        const detail = document.getElementById('web-site-detail');
        if (!detail) return;
        detail.style.display = 'block';

        const lr = await Auth.apiCall(`/api/websites/${id}/logs`);
        const data = lr && lr.ok ? await lr.json() : { logs: [] };
        const site = this._sites.find(s =>s.id === id);

        detail.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">${Lang.t('web.logs_title')} — ${site?.name || 'Site'}</h3>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span style="font-size:11px;color:var(--text-muted);">${data.logs.length} ${Lang.t('web.lines')}</span>
                        <button class="btn btn-secondary btn-sm" onclick="WebModule.showLogs(${id})">${Lang.t('web.refresh')}</button>
                        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('web-site-detail').style.display='none'"></button>
                    </div>
                </div>
                <div style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;">
                    ${data.logs.length >0
                        ? data.logs.map((l, i) =>`<div style="display:flex;gap:8px;"><span style="color:#6b7280;min-width:28px;text-align:right;user-select:none;">${i+1}</span><span>${l.replace(/</g,'&lt;')}</span></div>`).join('')
                        : `<div style="color:#6b7280;text-align:center;padding:20px;">${Lang.t('web.logs_empty')}</div>`
                    }
                </div>
            </div>`;
    },
};
