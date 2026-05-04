/**
 * BotsModule — Interface du Module Bots & Automatisation.
 * 
 * Permet de créer, éditer, démarrer, arrêter et monitorer des bots Python
 * directement depuis le panel OmenServer.
 */
const BotsModule = {
    _bots: [],
    _selectedBot: null,
    _refreshInterval: null,

    async render(container) {
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                <div>
                    <h1 style="margin:0;">🤖 Bots & Automatisation</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">Déployer et monitorer tes bots Python</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-primary" onclick="BotsModule.showCreateForm()">➕ Nouveau bot</button>
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">← Hub</button>
                </div>
            </div>

            <div id="bot-create-form" style="display:none;margin-bottom:20px;"></div>
            <div id="bots-grid"></div>
            <div id="bot-detail" style="display:none;margin-top:20px;"></div>
        `;

        await this.loadBots();

        // Refresh auto toutes les 5s
        this._refreshInterval = setInterval(() => this.loadBots(), 5000);
    },

    unload() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
        }
    },

    async loadBots() {
        const r = await Auth.apiCall('/api/bots');
        if (!r || !r.ok) return;
        this._bots = await r.json();
        this._renderGrid();
    },

    _renderGrid() {
        const grid = document.getElementById('bots-grid');
        if (!grid) return;

        const typeIcons = { trading: '📈', gaming: '🎮', scraper: '🕷️', analysis: '📊', custom: '🐍' };
        const statusColors = { running: '#22c55e', stopped: '#6b7280', error: '#ef4444' };
        const statusLabels = { running: '● En cours', stopped: '○ Arrêté', error: '⚠️ Erreur' };

        if (this._bots.length === 0) {
            grid.innerHTML = `
                <div style="text-align:center;padding:60px;">
                    <div style="font-size:48px;margin-bottom:12px;">🤖</div>
                    <div style="color:var(--text-muted);font-size:15px;">Aucun bot</div>
                    <div style="color:var(--text-muted);font-size:12px;margin-top:4px;">Clique sur "Nouveau bot" pour commencer</div>
                </div>`;
            return;
        }

        grid.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
                ${this._bots.map(b => `
                    <div class="card" style="cursor:pointer;transition:all .15s;border:2px solid ${this._selectedBot?.id === b.id ? 'var(--accent-blue)' : 'transparent'};"
                        onclick="BotsModule.selectBot(${b.id})"
                        onmouseover="this.style.transform='translateY(-2px)'"
                        onmouseout="this.style.transform=''">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:24px;">${typeIcons[b.bot_type] || '🐍'}</span>
                                <div>
                                    <div style="font-weight:700;font-size:14px;">${b.name}</div>
                                    <div style="font-size:11px;color:var(--text-muted);">${b.bot_type}</div>
                                </div>
                            </div>
                            <span style="font-size:11px;padding:2px 8px;border-radius:4px;color:${statusColors[b.status]};background:${statusColors[b.status]}15;font-weight:600;">
                                ${statusLabels[b.status] || b.status}
                            </span>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${b.description || 'Pas de description'}</div>
                        <div style="display:flex;gap:6px;">
                            ${b.status === 'running' 
                                ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();BotsModule.stopBot(${b.id})" style="font-size:11px;padding:4px 12px;">⏹ Stop</button>`
                                : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();BotsModule.startBot(${b.id})" style="font-size:11px;padding:4px 12px;">▶ Start</button>`
                            }
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();BotsModule.openEditor(${b.id})" style="font-size:11px;padding:4px 12px;">✏️ Code</button>
                            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();BotsModule.deleteBot(${b.id})" style="font-size:11px;padding:4px 8px;color:#ef4444;">🗑</button>
                        </div>
                    </div>
                `).join('')}
            </div>`;
    },

    showCreateForm() {
        const form = document.getElementById('bot-create-form');
        if (!form) return;
        form.style.display = 'block';
        form.innerHTML = `
            <div class="card">
                <h3 style="margin:0 0 16px;">➕ Créer un bot</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                    <div>
                        <label class="form-label">Nom du bot</label>
                        <input id="bot-name" class="form-input" placeholder="Mon bot trading" />
                    </div>
                    <div>
                        <label class="form-label">Type</label>
                        <select id="bot-type" class="form-input">
                            <option value="custom">🐍 Custom</option>
                            <option value="trading">📈 Trading</option>
                            <option value="gaming">🎮 Gaming</option>
                            <option value="scraper">🕷️ Scraper</option>
                            <option value="analysis">📊 Analyse</option>
                        </select>
                    </div>
                    <div>
                        <label class="form-label">Description</label>
                        <input id="bot-desc" class="form-input" placeholder="Ce bot fait..." />
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-primary" onclick="BotsModule.createBot()">Créer</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('bot-create-form').style.display='none'">Annuler</button>
                    <span id="bot-create-msg" style="font-size:13px;"></span>
                </div>
            </div>`;
    },

    async createBot() {
        const name = document.getElementById('bot-name')?.value?.trim();
        const type = document.getElementById('bot-type')?.value || 'custom';
        const desc = document.getElementById('bot-desc')?.value?.trim() || '';
        const msg = document.getElementById('bot-create-msg');

        if (!name) { if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ Nom requis'; } return; }

        const r = await Auth.apiCall('/api/bots', {
            method: 'POST',
            body: JSON.stringify({ name, bot_type: type, description: desc })
        });

        if (r && r.ok) {
            document.getElementById('bot-create-form').style.display = 'none';
            await this.loadBots();
        } else {
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ Erreur'; }
        }
    },

    async startBot(id) {
        const r = await Auth.apiCall(`/api/bots/${id}/start`, { method: 'POST' });
        if (r && r.ok) {
            await this.loadBots();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            alert(`❌ ${err.detail || 'Erreur'}`);
        }
    },

    async stopBot(id) {
        const r = await Auth.apiCall(`/api/bots/${id}/stop`, { method: 'POST' });
        if (r && r.ok) await this.loadBots();
    },

    async deleteBot(id) {
        if (!confirm('Supprimer ce bot ?')) return;
        const r = await Auth.apiCall(`/api/bots/${id}`, { method: 'DELETE' });
        if (r && r.ok) {
            this._selectedBot = null;
            document.getElementById('bot-detail').style.display = 'none';
            await this.loadBots();
        }
    },

    async selectBot(id) {
        this._selectedBot = this._bots.find(b => b.id === id);
        this._renderGrid();
        await this.showBotDetail(id);
    },

    async showBotDetail(id) {
        const detail = document.getElementById('bot-detail');
        if (!detail) return;
        detail.style.display = 'block';

        // Charger les logs
        const lr = await Auth.apiCall(`/api/bots/${id}/logs`);
        const logs = lr && lr.ok ? await lr.json() : { logs: [] };
        const bot = this._bots.find(b => b.id === id);

        detail.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">📋 Logs — ${bot?.name || 'Bot'}</h3>
                    <button class="btn btn-secondary btn-sm" onclick="BotsModule.showBotDetail(${id})">🔄 Rafraîchir</button>
                </div>
                <div style="background:#0d1117;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto;font-family:monospace;font-size:12px;line-height:1.6;color:#c9d1d9;">
                    ${logs.logs.length > 0 
                        ? logs.logs.map(l => `<div>${l.replace(/</g,'&lt;')}</div>`).join('')
                        : '<div style="color:#6b7280;">Aucun log disponible</div>'
                    }
                </div>
            </div>`;
    },

    async openEditor(id) {
        const detail = document.getElementById('bot-detail');
        if (!detail) return;
        detail.style.display = 'block';

        const cr = await Auth.apiCall(`/api/bots/${id}/code`);
        const data = cr && cr.ok ? await cr.json() : { code: '' };
        const bot = this._bots.find(b => b.id === id);

        detail.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;">✏️ Éditeur — ${bot?.name || 'Bot'}</h3>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <span id="code-save-msg" style="font-size:12px;"></span>
                        <button class="btn btn-primary btn-sm" onclick="BotsModule.saveCode(${id})">💾 Sauvegarder</button>
                    </div>
                </div>
                <textarea id="bot-code-editor" style="width:100%;min-height:400px;background:#0d1117;color:#c9d1d9;border:1px solid var(--border-color);border-radius:8px;padding:12px;font-family:'Fira Code',monospace;font-size:13px;line-height:1.6;resize:vertical;tab-size:4;">${data.code.replace(/</g,'&lt;')}</textarea>
            </div>`;
    },

    async saveCode(id) {
        const code = document.getElementById('bot-code-editor')?.value || '';
        const msg = document.getElementById('code-save-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳...'; }

        const r = await Auth.apiCall(`/api/bots/${id}/code`, {
            method: 'PUT',
            body: JSON.stringify({ code })
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegardé !'; }
        } else {
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = '❌ Erreur'; }
        }
    },
};
