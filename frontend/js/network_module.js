/**
 * NetworkModule — Interface du Module Monitoring Réseau + Wake-on-LAN.
 *
 * Affiche le statut réseau en temps réel (latence, IP, qualité),
 * permet de lancer des speed tests, et de gérer les appareils WoL.
 */
const NetworkModule = {
    _refreshInterval: null,
    _status: null,

    async render(container) {
        console.log('[NetworkModule] render() called');
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                <div>
                    <h1 style="margin:0;">${Lang.t('net.title')}</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">${Lang.t('net.subtitle')}</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-secondary" onclick="NetworkModule.exportCSV()">${Lang.t('net.export_csv')}</button>
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">${Lang.t('net.back_hub')}</button>
                </div>
            </div>

            <div id="net-status-cards"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;">
                <div id="net-actions"></div>
                <div id="net-speedtest"></div>
            </div>

            <!-- Réseau bandwidth -->
            <div style="margin: 20px 0 0; font-size: 13px; color: var(--text-muted);">
                ${Lang.t('dashboard.network')} : <span id="stat-network">--</span>
            </div>

            <!-- Kill All + Diagnostic -->
            <div style="display:flex;gap:12px;margin:16px 0;align-items:center;">
                <button class="btn btn-kill-all" onclick="App.killAllServers()" title="${Lang.t('dashboard.kill_all')}">
                    ${Lang.t('dashboard.kill_all')}
                </button>
                <button class="btn btn-secondary" onclick="App.runDiagnostic()" id="diag-btn" style="display:flex;align-items:center;gap:6px;">
                    ${Lang.t('dashboard.diagnostic')}
                </button>
                <span style="font-size:12px;color:var(--text-muted);">${Lang.t('dashboard.quick_actions')}</span>
            </div>

            <!-- Diagnostic panel (caché par défaut) -->
            <div id="diagnostic-panel" style="display:none;margin-bottom:20px;"></div>

            <!-- Réseau de machines (Bento Tech PR13) -->
            <div style="margin-top:24px;">
                <div class="page-header" style="margin-bottom:12px;">
                    <h2 style="font-size: 18px; font-weight: 700;">${Lang.t('nodes.title')} <span id="nodes-count" style="font-size:13px;font-weight:400;color:var(--text-dim);font-family:var(--font-mono);font-feature-settings:'tnum';"></span></h2>
                </div>
                <div id="nodes-grid" class="machines-grid">
                    <div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-dim);font-size:13px;">
                        ${Lang.t('common.loading')}
                    </div>
                </div>
            </div>

            <div id="net-history" style="margin-top:20px;"></div>
            <div id="net-wol" style="margin-top:20px;"></div>
        `;

        await this.loadStatus();
        await this._loadHistory();
        await this._loadDevices();
        this._loadNodes();
        this._refreshInterval = setInterval(() => {
            this.loadStatus();
            this._loadNodes();
        }, 10000);
    },

    unload() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
        }
    },

    /**
     * Charge la liste des PC connectés via le Monitoring existant.
     * Réutilise Monitoring.renderNodes() qui écrit dans #nodes-grid.
     */
    async _loadNodes() {
        if (typeof Monitoring !== 'undefined') {
            // S'assurer que le hostname du serveur est chargé
            if (!Monitoring._serverHostname) {
                await Monitoring._fetchHostname();
            }
            // Charger les stats du serveur si pas encore disponibles
            if (!Monitoring._lastServerData) {
                const r = await Auth.apiCall('/api/monitoring/stats');
                if (r && r.ok) {
                    Monitoring._lastServerData = await r.json();
                }
            }
            // Charger et afficher les nodes
            await Monitoring.fetchNodes();
        }
    },

    async loadStatus() {
        const r = await Auth.apiCall('/api/network/status');
        if (!r || !r.ok) return;
        this._status = await r.json();
        this._renderStatusCards();
        this._renderActions();
    },

    _renderStatusCards() {
        const el = document.getElementById('net-status-cards');
        if (!el) return;
        const s = this._status;

        // Map quality to Bento semantic classes
        const qualityClass = {
            excellent: 'up', good: 'up', average: 'alert',
            poor: 'down', offline: 'down'
        }[s.quality] || '';

        // PR 9 — Bento overview grid, 4 stats single row
        el.innerHTML = `
            <div class="bento-overview" style="grid-template-columns:1fr 1fr 1fr 1fr;grid-template-rows:1fr;">
                <div class="stat-card">
                    <div class="label">${Lang.t('net.status')}</div>
                    <div class="value"><span class="delta ${qualityClass}">${s.quality_label}</span></div>
                </div>
                <div class="stat-card">
                    <div class="label">${Lang.t('net.latency')}</div>
                    <div class="value">${s.latency_ms !== null ? s.latency_ms : '--'}<span class="unit">ms</span></div>
                </div>
                <div class="stat-card">
                    <div class="label">${Lang.t('net.public_ip')}</div>
                    <div class="value" style="font-size:18px;letter-spacing:0;">${s.public_ip || '--'}</div>
                </div>
                <div class="stat-card">
                    <div class="label">${Lang.t('net.local_ip')}</div>
                    <div class="value" style="font-size:18px;letter-spacing:0;">${s.local_ip || '--'}</div>
                </div>
            </div>`;
    },

    _renderActions() {
        const el = document.getElementById('net-actions');
        if (!el) return;
        el.innerHTML = `
            <div class="card">
                <h3 style="margin:0 0 12px;font-size:15px;">${Lang.t('net.actions')}</h3>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button class="btn btn-secondary" onclick="NetworkModule.runPing()" style="text-align:left;">
                        ${Lang.t('net.ping')}
                    </button>
                    <button class="btn btn-secondary" onclick="NetworkModule.runSpeedTest()" id="speedtest-btn" style="text-align:left;">
                        ${Lang.t('net.speedtest')}
                    </button>
                    <button class="btn btn-secondary" onclick="NetworkModule._loadHistory()" style="text-align:left;">
                        ${Lang.t('net.refresh_history')}
                    </button>
                </div>
            </div>`;

        const st = document.getElementById('net-speedtest');
        if (st && !st.innerHTML.trim()) {
            st.innerHTML = `
                <div class="card">
                    <h3 style="margin:0 0 12px;font-size:15px;">${Lang.t('net.last_speedtest')}</h3>
                    <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">
                        ${Lang.t('net.speedtest_hint')}
                    </div>
                </div>`;
        }
    },

    async runPing() {
        const r = await Auth.apiCall('/api/network/ping', { method: 'POST' });
        if (r && r.ok) {
            const data = await r.json();
            await this.loadStatus();
            await this._loadHistory();
        }
    },

    async runSpeedTest() {
        const btn = document.getElementById('speedtest-btn');
        const st = document.getElementById('net-speedtest');
        if (btn) { btn.disabled = true; btn.textContent = Lang.t('net.testing'); }

        const r = await Auth.apiCall('/api/network/speedtest', { method: 'POST' });

        if (r && r.ok) {
            const data = await r.json();
            if (st) {
                st.innerHTML = `
                    <div class="card">
                        <h3 style="margin:0 0 16px;font-size:15px;">${Lang.t('net.speedtest_results')}</h3>
                        <div class="bento-overview" style="grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr;gap:8px;">
                            <div class="stat-card" style="padding:var(--s-3);">
                                <div class="label">${Lang.t('net.latency')}</div>
                                <div class="value" style="font-size:22px;">${data.latency_ms || '--'}<span class="unit">ms</span></div>
                            </div>
                            <div class="stat-card" style="padding:var(--s-3);">
                                <div class="label">Download</div>
                                <div class="value" style="font-size:22px;color:var(--accent);">${data.download_mbps || '--'}<span class="unit">Mbps</span></div>
                            </div>
                            <div class="stat-card" style="padding:var(--s-3);">
                                <div class="label">Upload</div>
                                <div class="value" style="font-size:22px;color:var(--info);">${data.upload_mbps || '--'}<span class="unit">Mbps</span></div>
                            </div>
                        </div>
                    </div>`;
            }
            await this._loadHistory();
        }

        if (btn) { btn.disabled = false; btn.textContent = Lang.t('net.speedtest'); }
    },

    async _loadHistory() {
        const el = document.getElementById('net-history');
        if (!el) return;

        const r = await Auth.apiCall('/api/network/history?hours=24');
        if (!r || !r.ok) return;
        const data = await r.json();
        const logs = data.logs || [];
        const locale = Lang.t('common.locale') || 'fr-FR';

        if (logs.length === 0) {
            el.innerHTML = `
                <div class="card">
                    <h3 style="margin:0 0 12px;font-size:15px;">${Lang.t('net.history_title')}</h3>
                    <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
                        ${Lang.t('net.history_empty')}
                    </div>
                </div>`;
            return;
        }

        // Dessiner un mini graphique en barres ASCII pour la latence
        const maxLatency = Math.max(...logs.filter(l => l.latency_ms).map(l => l.latency_ms), 1);
        const barWidth = Math.max(4, Math.floor(600 / logs.length));

        el.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;font-size:15px;">${Lang.t('net.history_title')}</h3>
                    <span style="font-size:12px;color:var(--text-muted);">${logs.length} ${Lang.t('net.measurements')}</span>
                </div>
                <div style="display:flex;align-items:flex-end;gap:2px;height:80px;padding:8px;background:var(--bg-elev-3);border-radius:8px;overflow-x:auto;">
                    ${logs.slice(-60).map(log => {
                        const h = log.latency_ms ? Math.max(4, (log.latency_ms / maxLatency) * 70) : 0;
                        const color = !log.latency_ms ? 'var(--danger)' : log.latency_ms < 30 ? 'var(--accent)' : log.latency_ms < 80 ? 'var(--warning)' : 'var(--danger)';
                        return `<div style="width:${barWidth}px;height:${h}px;background:${color};border-radius:2px;flex-shrink:0;" title="${log.latency_ms || 'offline'} ms — ${new Date(log.timestamp).toLocaleTimeString(locale)}"></div>`;
                    }).join('')}
                </div>
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:4px;">
                    <span>${logs.length > 0 ? new Date(logs[Math.max(0, logs.length-60)].timestamp).toLocaleTimeString(locale) : ''}</span>
                    <span>${Lang.t('net.now')}</span>
                </div>
            </div>`;
    },

    async _loadDevices() {
        const el = document.getElementById('net-wol');
        if (!el) return;

        const r = await Auth.apiCall('/api/network/devices');
        if (!r || !r.ok) return;
        const devices = await r.json();
        const locale = Lang.t('common.locale') || 'fr-FR';

        el.innerHTML = `
            <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;font-size:15px;">${Lang.t('net.wol_title')}</h3>
                    <button class="btn btn-secondary btn-sm" onclick="NetworkModule.showAddDevice()">${Lang.t('net.wol_add')}</button>
                </div>
                <div id="wol-add-form" style="display:none;margin-bottom:12px;"></div>
                ${devices.length === 0 ? `
                    <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">
                        <div style="font-size:32px;margin-bottom:8px;"></div>
                        ${Lang.t('net.wol_empty')}<br>
                        <span style="font-size:11px;">${Lang.t('net.wol_empty_hint')}</span>
                    </div>
                ` : `
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        ${devices.map(d => `
                            <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-elev-3);border-radius:8px;border:1px solid var(--border);">
                                <span style="font-size:24px;"></span>
                                <div style="flex:1;">
                                    <div style="font-size:14px;font-weight:600;">${d.name}</div>
                                    <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">${d.mac_address}${d.ip_hint ? ' · ' + d.ip_hint : ''}</div>
                                    ${d.last_wake ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${Lang.t('net.wol_last_wake')}: ${new Date(d.last_wake).toLocaleString(locale)}</div>` : ''}
                                </div>
                                <div style="display:flex;gap:6px;">
                                    <button class="btn btn-primary btn-sm" onclick="NetworkModule.wakeDevice(${d.id})" style="font-size:12px;padding:6px 14px;">
                                        ${Lang.t('net.wol_wake')}
                                    </button>
                                    <button class="btn btn-secondary btn-sm" onclick="NetworkModule.deleteDevice(${d.id})" style="font-size:11px;padding:4px 8px;color:var(--danger);">
                                        
                                    </button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `}
            </div>`;
    },

    showAddDevice() {
        const form = document.getElementById('wol-add-form');
        if (!form) return;
        form.style.display = 'block';
        form.innerHTML = `
            <div style="padding:12px;background:var(--bg-elev-3);border-radius:8px;border:1px solid var(--border);">
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;">
                    <div>
                        <label class="form-label">${Lang.t('net.wol_name')}</label>
                        <input id="wol-name" class="form-input" placeholder="PC Bureau" />
                    </div>
                    <div>
                        <label class="form-label">${Lang.t('net.wol_mac')}</label>
                        <input id="wol-mac" class="form-input" placeholder="AA:BB:CC:DD:EE:FF" />
                    </div>
                    <div>
                        <label class="form-label">${Lang.t('net.wol_ip')}</label>
                        <input id="wol-ip" class="form-input" placeholder="192.168.1.100" />
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-primary btn-sm" onclick="NetworkModule.addDevice()">${Lang.t('common.confirm')}</button>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('wol-add-form').style.display='none'">${Lang.t('common.cancel')}</button>
                    <span id="wol-msg" style="font-size:12px;"></span>
                </div>
            </div>`;
    },

    async addDevice() {
        const name = document.getElementById('wol-name')?.value?.trim();
        const mac = document.getElementById('wol-mac')?.value?.trim();
        const ip = document.getElementById('wol-ip')?.value?.trim() || null;
        const msg = document.getElementById('wol-msg');

        if (!name || !mac) { if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = Lang.t('net.wol_name_mac_required'); } return; }

        const r = await Auth.apiCall('/api/network/devices', {
            method: 'POST',
            body: JSON.stringify({ name, mac_address: mac, ip_hint: ip })
        });

        if (r && r.ok) {
            await this._loadDevices();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = `${err.detail || Lang.t('common.error')}`; }
        }
    },

    async wakeDevice(id) {
        const r = await Auth.apiCall(`/api/network/wake/${id}`, { method: 'POST' });
        if (r && r.ok) {
            const data = await r.json();
            if (typeof Toast !== 'undefined') Toast.success(`${data.message}`);
            else alert(`${data.message}`);
            await this._loadDevices();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
            else alert(`${err.detail || Lang.t('common.error')}`);
        }
    },

    async deleteDevice(id) {
        if (!confirm(Lang.t('net.wol_delete_confirm'))) return;
        const r = await Auth.apiCall(`/api/network/devices/${id}`, { method: 'DELETE' });
        if (r && r.ok) await this._loadDevices();
    },

    async exportCSV() {
        const r = await Auth.apiCall('/api/network/history?hours=24');
        if (!r || !r.ok) { Toast.error(Lang.t('net.csv_error')); return; }
        const data = await r.json();
        const logs = data.logs || [];
        if (logs.length === 0) { Toast.warn(Lang.t('net.csv_empty')); return; }

        const header = 'Timestamp,Latence (ms),IP Publique,Download (Mbps),Upload (Mbps)\n';
        const rows = logs.map(l => 
            `${l.timestamp || ''},${l.latency_ms || ''},${l.public_ip || ''},${l.download_mbps || ''},${l.upload_mbps || ''}`
        ).join('\n');

        const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `omenserver-network-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.success(`${logs.length} ${Lang.t('net.csv_success')}`);
    },
};
