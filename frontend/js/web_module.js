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
                    <h1 style="margin:0;">🌐 Serveur Web</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">Héberger des sites web et APIs via Docker</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-primary" onclick="WebModule.showCreateForm()">➕ Nouveau site</button>
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Hub</button>
                </div>
            </div>

            <div id="web-create-form" style="display:none;margin-bottom:20px;"></div>
            <div id="web-sites-grid"><div style="text-align:center;padding:20px;color:var(--text-muted);">⏳ Chargement...</div></div>
            <div id="web-site-detail" style="display:none;margin-top:20px;"></div>
        `;

        await this.loadSites();
        this._refreshInterval = setInterval(() => this.loadSites(), 6000);
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

        const typeIcons = { static: '🌐', node: '⚡', php: '🐘', python: '🐍' };
        const statusColors = { running: '#22c55e', stopped: '#6b7280', error: '#ef4444' };
        const statusLabels = { running: '● En ligne', stopped: '○ Arrêté', error: '⚠️ Erreur' };

        if (this._sites.length === 0) {
            grid.innerHTML = `
                <div style="text-align:center;padding:60px;">
                    <div style="font-size:48px;margin-bottom:12px;">🌐</div>
                    <div style="color:var(--text-muted);font-size:15px;">Aucun site web</div>
                    <div style="color:var(--text-muted);font-size:12px;margin-top:4px;">Clique sur "Nouveau site" pour héberger ton premier site</div>
                </div>`;
            return;
        }

        grid.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;">
                ${this._sites.map(s => `
                    <div class="card" style="cursor:pointer;transition:all .15s;"
                        onmouseover="this.style.transform='translateY(-2px)'"
                        onmouseout="this.style.transform=''">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <span style="font-size:28px;">${typeIcons[s.site_type] || '🌐'}</span>
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
                            <div style="padding:8px;background:var(--bg-primary);border-radius:6px;border:1px solid var(--border-color);margin-bottom:12px;">
                                <a href="${s.url}" target="_blank" style="color:var(--accent-blue);font-size:12px;text-decoration:none;font-family:monospace;">
                                    ${s.url} ↗
                                </a>
                            </div>
                        ` : ''}
                        <div style="display:flex;gap:6px;">
                            ${s.status === 'running'
                                ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();WebModule.stopSite(${s.id})" style="font-size:11px;padding:4px 12px;">⏹ Stop</button>`
                                : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();WebModule.startSite(${s.id})" style="font-size:11px;padding:4px 12px;">▶ Start</button>`
                            }
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();WebModule.showLogs(${s.id})" style="font-size:11px;padding:4px 12px;">📋 Logs</button>
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();WebModule.deleteSite(${s.id})" style="font-size:11px;padding:4px 8px;color:#ef4444;">🗑</button>
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
                <h3 style="margin:0 0 16px;">➕ Créer un site web</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                    <div>
                        <label class="form-label">Nom du site</label>
                        <input id="web-name" class="form-input" placeholder="Mon site" />
                    </div>
                    <div>
                        <label class="form-label">Type</label>
                        <select id="web-type" class="form-input">
                            <option value="static">🌐 Site statique (Nginx)</option>
                            <option value="node">⚡ Node.js</option>
                            <option value="php">🐘 PHP (Apache)</option>
                            <option value="python">🐍 Python</option>
                        </select>
                    </div>
                    <div>
                        <label class="form-label">Port</label>
                        <input id="web-port" class="form-input" type="number" value="3000" min="1024" max="65535" />
                    </div>
                    <div>
                        <label class="form-label">Description</label>
                        <input id="web-desc" class="form-input" placeholder="Mon projet..." />
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-primary" onclick="WebModule.createSite()">Créer</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('web-create-form').style.display='none'">Annuler</button>
                    <span id="web-create-msg" style="font-size:13px;"></span>
                </div>
            </div>`;
    },

    async createSite() {
        const name = document.getElementById('web-name')?.value?.trim();
        const type = document.getElementById('web-type')?.value || 'static';
        const port = parseInt(document.getElementById('web-port')?.value) || 3000;
        const desc = document.getElementById('web-desc')?.value?.trim() || '';
        const msg = document.getElementById('web-create-msg');

        if (!name) { if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ Nom requis'; } return; }

        const r = await Auth.apiCall('/api/websites', {
            method: 'POST',
            body: JSON.stringify({ name, site_type: type, port, description: desc })
        });

        if (r && r.ok) {
            document.getElementById('web-create-form').style.display = 'none';
            await this.loadSites();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async startSite(id) {
        const r = await Auth.apiCall(`/api/websites/${id}/start`, { method: 'POST' });
        if (r && r.ok) await this.loadSites();
        else { const err = r ? await r.json().catch(() => ({})) : {}; if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Erreur'); else alert(`❌ ${err.detail || 'Erreur'}`); }
    },

    async stopSite(id) {
        const r = await Auth.apiCall(`/api/websites/${id}/stop`, { method: 'POST' });
        if (r && r.ok) await this.loadSites();
    },

    async deleteSite(id) {
        if (!confirm('Supprimer ce site web ?')) return;
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
        const site = this._sites.find(s => s.id === id);

        detail.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 Logs — ${site?.name || 'Site'}</h3>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span style="font-size:11px;color:var(--text-muted);">${data.logs.length} ligne(s)</span>
                        <button class="btn btn-secondary btn-sm" onclick="WebModule.showLogs(${id})">🔄 Rafraîchir</button>
                        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('web-site-detail').style.display='none'">✕</button>
                    </div>
                </div>
                <div style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:'Fira Code',monospace;font-size:12px;line-height:1.6;color:#c9d1d9;">
                    ${data.logs.length > 0
                        ? data.logs.map((l, i) => `<div style="display:flex;gap:8px;"><span style="color:#6b7280;min-width:28px;text-align:right;user-select:none;">${i+1}</span><span>${l.replace(/</g,'&lt;')}</span></div>`).join('')
                        : '<div style="color:#6b7280;text-align:center;padding:20px;">Aucun log — Démarre le site pour voir les logs</div>'
                    }
                </div>
            </div>`;
    },
};
