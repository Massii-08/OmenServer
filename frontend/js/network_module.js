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
            <div id="net-history" style="margin-top:20px;"></div>
            <div id="net-wol" style="margin-top:20px;"></div>
        `;

        await this.loadStatus();
        await this._loadHistory();
        await this._loadDevices();
        this._refreshInterval = setInterval(() => this.loadStatus(), 10000);
    },

    unload() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
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

        const qualityColors = {
            excellent: '#22c55e', good: '#22c55e', average: '#f59e0b',
            poor: '#ef4444', offline: '#ef4444'
        };
        const latencyColor = qualityColors[s.quality] || '#6b7280';

        el.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
                <div class="card" style="text-align:center;">
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('net.status')}</div>
                    <div style="font-size:20px;font-weight:700;color:${latencyColor};">
                        ${s.quality_label}
                    </div>
                </div>
                <div class="card" style="text-align:center;">
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('net.latency')}</div>
                    <div style="font-size:24px;font-weight:700;">
                        ${s.latency_ms !== null ? s.latency_ms : '--'}
                        <span style="font-size:14px;color:var(--text-muted);">ms</span>
                    </div>
                </div>
                <div class="card" style="text-align:center;">
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('net.public_ip')}</div>
                    <div style="font-size:14px;font-weight:600;font-family:monospace;">
                        ${s.public_ip || '--'}
                    </div>
                </div>
                <div class="card" style="text-align:center;">
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${Lang.t('net.local_ip')}</div>
                    <div style="font-size:14px;font-weight:600;font-family:monospace;">
                        ${s.local_ip || '--'}
                    </div>
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
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                            <div style="text-align:center;padding:12px;background:var(--bg-primary);border-radius:8px;">
                                <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${Lang.t('net.latency')}</div>
                                <div style="font-size:20px;font-weight:700;">${data.latency_ms || '--'} <span style="font-size:12px;color:var(--text-muted);">ms</span></div>
                            </div>
                            <div style="text-align:center;padding:12px;background:var(--bg-primary);border-radius:8px;">
                                <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Download</div>
                                <div style="font-size:20px;font-weight:700;color:var(--accent-green);">${data.download_mbps || '--'} <span style="font-size:12px;color:var(--text-muted);">Mbps</span></div>
                            </div>
                            <div style="text-align:center;padding:12px;background:var(--bg-primary);border-radius:8px;">
                                <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Upload</div>
                                <div style="font-size:20px;font-weight:700;color:var(--accent-blue);">${data.upload_mbps || '--'} <span style="font-size:12px;color:var(--text-muted);">Mbps</span></div>
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
                <div style="display:flex;align-items:flex-end;gap:2px;height:80px;padding:8px;background:var(--bg-primary);border-radius:8px;overflow-x:auto;">
                    ${logs.slice(-60).map(log => {
                        const h = log.latency_ms ? Math.max(4, (log.latency_ms / maxLatency) * 70) : 0;
                        const color = !log.latency_ms ? '#ef4444' : log.latency_ms < 30 ? '#22c55e' : log.latency_ms < 80 ? '#f59e0b' : '#ef4444';
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
                        <div style="font-size:32px;margin-bottom:8px;">💻</div>
                        ${Lang.t('net.wol_empty')}<br>
                        <span style="font-size:11px;">${Lang.t('net.wol_empty_hint')}</span>
                    </div>
                ` : `
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        ${devices.map(d => `
                            <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
                                <span style="font-size:24px;">🖥️</span>
                                <div style="flex:1;">
                                    <div style="font-size:14px;font-weight:600;">${d.name}</div>
                                    <div style="font-size:11px;color:var(--text-muted);font-family:monospace;">${d.mac_address}${d.ip_hint ? ' · ' + d.ip_hint : ''}</div>
                                    ${d.last_wake ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${Lang.t('net.wol_last_wake')}: ${new Date(d.last_wake).toLocaleString(locale)}</div>` : ''}
                                </div>
                                <div style="display:flex;gap:6px;">
                                    <button class="btn btn-primary btn-sm" onclick="NetworkModule.wakeDevice(${d.id})" style="font-size:12px;padding:6px 14px;">
                                        ${Lang.t('net.wol_wake')}
                                    </button>
                                    <button class="btn btn-secondary btn-sm" onclick="NetworkModule.deleteDevice(${d.id})" style="font-size:11px;padding:4px 8px;color:#ef4444;">
                                        🗑
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
            <div style="padding:12px;background:var(--bg-primary);border-radius:8px;border:1px solid var(--border-color);">
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

        if (!name || !mac) { if (msg) { msg.style.color = '#ef4444'; msg.textContent = Lang.t('net.wol_name_mac_required'); } return; }

        const r = await Auth.apiCall('/api/network/devices', {
            method: 'POST',
            body: JSON.stringify({ name, mac_address: mac, ip_hint: ip })
        });

        if (r && r.ok) {
            await this._loadDevices();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || Lang.t('common.error')}`; }
        }
    },

    async wakeDevice(id) {
        const r = await Auth.apiCall(`/api/network/wake/${id}`, { method: 'POST' });
        if (r && r.ok) {
            const data = await r.json();
            if (typeof Toast !== 'undefined') Toast.success(`⚡ ${data.message}`);
            else alert(`⚡ ${data.message}`);
            await this._loadDevices();
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
            else alert(`❌ ${err.detail || Lang.t('common.error')}`);
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
        Toast.success(`📊 ${logs.length} ${Lang.t('net.csv_success')}`);
    },
};
