/**
 * Monitoring.js — Graphiques de monitoring en temps réel.
 * 
 * Appelle l'API /api/monitoring/stats toutes les 2 secondes
 * et met à jour les jauges CPU, RAM, Disque, Température.
 */

const Monitoring = {
    // Intervalle de rafraîchissement en ms
    REFRESH_INTERVAL: 2000,
    // ID du setInterval en cours
    _intervalId: null,
    // Historique pour les mini-graphiques
    _history: { cpu: [], memory: [], disk: [] },
    MAX_HISTORY: 30,

    /**
     * Démarre le monitoring (appel toutes les 2s).
     */
    start() {
        this.fetchStats(); // Premier appel immédiat
        this._intervalId = setInterval(() => this.fetchStats(), this.REFRESH_INTERVAL);
    },

    /**
     * Arrête le monitoring.
     */
    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
    },

    /**
     * Récupère les stats depuis l'API et met à jour l'UI.
     */
    async fetchStats() {
        const response = await Auth.apiCall('/api/monitoring/stats');
        if (!response) return;

        const data = await response.json();
        this.updateUI(data);
        this.updateHistory(data);

        // Nodes: rafraîchir toutes les 2 cycles (~4s)
        this._nodesCycle = (this._nodesCycle || 0) + 1;
        if (this._nodesCycle % 2 === 0) {
            this.fetchNodes();
        }
    },

    /**
     * Récupère la liste des PC connectés et met à jour le dashboard.
     */
    async fetchNodes() {
        const r = await Auth.apiCall('/api/nodes');
        if (!r || !r.ok) return;

        const nodes = await r.json();
        this.renderNodes(nodes);
    },

    /**
     * Affiche les cartes des PC connectés dans le dashboard.
     */
    renderNodes(nodes) {
        const grid = document.getElementById('nodes-grid');
        const countEl = document.getElementById('nodes-count');
        if (!grid) return;

        if (!nodes || nodes.length === 0) {
            if (countEl) countEl.textContent = '';
            grid.innerHTML = `
                <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;grid-column:1/-1;">
                    <div style="font-size:32px;margin-bottom:8px;">💻</div>
                    ${Lang.t('nodes.no_nodes')}<br>
                    <span style="font-size:11px;">${Lang.t('nodes.no_nodes_hint')}</span>
                </div>`;
            return;
        }

        const online = nodes.filter(n => n.online).length;
        if (countEl) {
            countEl.textContent = `(${online}/${nodes.length})`;
        }

        grid.innerHTML = nodes.map(node => {
            const statusColor = node.online ? 'var(--accent-green)' : 'var(--accent-red)';
            const statusIcon = node.online ? '🟢' : '🔴';
            const statusText = node.online ? Lang.t('nodes.online') : Lang.t('nodes.offline');
            const opacity = node.online ? '1' : '0.6';

            // Formater le temps offline
            let offlineText = '';
            if (!node.online) {
                const secs = node.last_seen_seconds_ago;
                if (secs < 60) offlineText = `${Math.round(secs)}s`;
                else if (secs < 3600) offlineText = `${Math.round(secs / 60)} min`;
                else offlineText = `${Math.round(secs / 3600)}h`;
                offlineText = `${Lang.t('nodes.since')} ${offlineText}`;
            }

            // Formater l'uptime
            let uptimeText = '';
            if (node.uptime_hours < 1) uptimeText = `${Math.round(node.uptime_hours * 60)} min`;
            else if (node.uptime_hours < 24) uptimeText = `${Math.round(node.uptime_hours)}h`;
            else uptimeText = `${Math.round(node.uptime_hours / 24)}j ${Math.round(node.uptime_hours % 24)}h`;

            // Couleur des barres selon la valeur
            const barColor = (v) => v > 90 ? 'var(--accent-red)' : v > 70 ? 'var(--accent-yellow)' : 'var(--accent-green)';

            return `
                <div style="background:var(--bg-secondary);border-radius:12px;padding:16px;border:1px solid var(--border-color);opacity:${opacity};transition:all 0.3s;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <div>
                            <div style="font-weight:700;font-size:14px;">${statusIcon} ${node.hostname}</div>
                            <div style="font-size:11px;color:var(--text-muted);">${node.os}</div>
                        </div>
                        <div style="text-align:right;">
                            <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${node.online ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${statusColor};">${statusText}</span>
                            ${!node.online ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${offlineText}</div>` : ''}
                        </div>
                    </div>
                    ${node.online ? `
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <div>
                            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                                <span>CPU</span>
                                <span style="font-weight:600;">${Math.round(node.cpu_percent)}%</span>
                            </div>
                            <div style="height:6px;background:var(--bg-primary);border-radius:3px;overflow:hidden;">
                                <div style="height:100%;width:${Math.min(node.cpu_percent, 100)}%;background:${barColor(node.cpu_percent)};border-radius:3px;transition:width 0.5s;"></div>
                            </div>
                        </div>
                        <div>
                            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                                <span>RAM</span>
                                <span style="font-weight:600;">${node.ram_used_gb}/${node.ram_total_gb} Go (${Math.round(node.ram_percent)}%)</span>
                            </div>
                            <div style="height:6px;background:var(--bg-primary);border-radius:3px;overflow:hidden;">
                                <div style="height:100%;width:${Math.min(node.ram_percent, 100)}%;background:${barColor(node.ram_percent)};border-radius:3px;transition:width 0.5s;"></div>
                            </div>
                        </div>
                        <div>
                            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                                <span>Disque</span>
                                <span style="font-weight:600;">${node.disk_used_gb}/${node.disk_total_gb} Go (${Math.round(node.disk_percent)}%)</span>
                            </div>
                            <div style="height:6px;background:var(--bg-primary);border-radius:3px;overflow:hidden;">
                                <div style="height:100%;width:${Math.min(node.disk_percent, 100)}%;background:${barColor(node.disk_percent)};border-radius:3px;transition:width 0.5s;"></div>
                            </div>
                        </div>
                        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:4px;">
                            <span>${node.temperature ? `🌡️ ${node.temperature}°C` : ''}</span>
                            <span>⏱️ ${uptimeText} ${Lang.t('nodes.uptime')}</span>
                        </div>
                        ${Auth.getUser()?.is_admin ? `
                        <div style="display:flex;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-color);">
                            <button class="btn btn-sm btn-secondary" onclick="Monitoring.nodeAction('${node.hostname}', 'reboot')" style="font-size:11px;padding:3px 8px;" title="${Lang.t('nodes.reboot_desc')}">🔄 ${Lang.t('nodes.reboot')}</button>
                            <button class="btn btn-sm btn-secondary" onclick="Monitoring.nodeAction('${node.hostname}', 'shutdown')" style="font-size:11px;padding:3px 8px;" title="${Lang.t('nodes.shutdown_desc')}">⏻ ${Lang.t('nodes.shutdown')}</button>
                            <div style="flex:1;"></div>
                            <button class="btn btn-sm btn-secondary" onclick="Monitoring.removeNode('${node.hostname}')" style="font-size:11px;padding:3px 8px;opacity:0.5;" title="${Lang.t('nodes.remove')}">✕</button>
                        </div>
                        ` : ''}
                    </div>
                    ` : `
                    <div style="text-align:center;padding:12px 0;color:var(--text-muted);font-size:12px;">
                        ⏻ ${Lang.t('nodes.offline')}
                        ${Auth.getUser()?.is_admin ? `<br><button class="btn btn-sm btn-secondary" onclick="Monitoring.removeNode('${node.hostname}')" style="font-size:10px;padding:2px 6px;margin-top:6px;opacity:0.5;">✕ ${Lang.t('nodes.remove')}</button>` : ''}
                    </div>
                    `}
                </div>`;
        }).join('');
    },

    /**
     * Envoie une commande à distance (reboot/shutdown) à un PC.
     */
    async nodeAction(hostname, action) {
        const actionLabel = action === 'reboot' ? Lang.t('nodes.reboot') : Lang.t('nodes.shutdown');
        const confirmKey = action === 'reboot' ? 'nodes.reboot_confirm' : 'nodes.shutdown_confirm';
        if (!confirm(Lang.t(confirmKey).replace('{name}', hostname))) return;

        const r = await Auth.apiCall(`/api/nodes/${encodeURIComponent(hostname)}/${action}`, { method: 'POST' });
        if (r && r.ok) {
            const data = await r.json();
            if (typeof Toast !== 'undefined') Toast.success(data.message);
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Erreur');
        }
    },

    /**
     * Retire un PC de la liste des nodes.
     */
    async removeNode(hostname) {
        if (!confirm(Lang.t('nodes.remove_confirm'))) return;

        const r = await Auth.apiCall(`/api/nodes/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
        if (r && r.ok) {
            if (typeof Toast !== 'undefined') Toast.success(`✅ ${hostname} retiré`);
            this.fetchNodes(); // Refresh
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || 'Erreur');
        }
    },

    updateUI(data) {
        // CPU
        this.updateStat('cpu', data.cpu.percent, '%');
        // RAM
        this.updateStat('memory', data.memory.percent, '%',
            `${data.memory.used_gb} / ${data.memory.total_gb} Go`);
        // Disque
        this.updateStat('disk', data.disk.percent, '%',
            `${data.disk.used_gb} / ${data.disk.total_gb} Go`);
        // Température
        if (data.temperature.available) {
            this.updateStat('temp', data.temperature.cpu_temp, '°C');
        } else {
            const tempValue = document.getElementById('stat-temp-value');
            if (tempValue) tempValue.textContent = 'N/A';
        }
        // Réseau
        const netEl = document.getElementById('stat-network');
        if (netEl) {
            netEl.textContent = `↑ ${data.network.bytes_sent_mb} Mo  ↓ ${data.network.bytes_recv_mb} Mo`;
        }
    },

    /**
     * Met à jour une carte de stat individuelle.
     */
    updateStat(id, value, unit, detail) {
        const valueEl = document.getElementById(`stat-${id}-value`);
        const barEl = document.getElementById(`stat-${id}-bar`);
        const detailEl = document.getElementById(`stat-${id}-detail`);

        if (valueEl) valueEl.textContent = Math.round(value);
        if (barEl) barEl.style.width = `${Math.min(value, 100)}%`;
        if (detailEl && detail) detailEl.textContent = detail;

        // Changer la couleur si la valeur est élevée
        if (barEl) {
            if (value > 90) barEl.style.background = 'var(--accent-red)';
            else if (value > 70) barEl.style.background = 'var(--accent-yellow)';
            else barEl.style.background = 'var(--stat-color, var(--accent-green))';
        }
    },

    /**
     * Stocke l'historique pour des mini-graphiques futurs.
     */
    updateHistory(data) {
        this._history.cpu.push(data.cpu.percent);
        this._history.memory.push(data.memory.percent);
        this._history.disk.push(data.disk.percent);

        // Garder seulement les X dernières valeurs
        Object.keys(this._history).forEach(key => {
            if (this._history[key].length > this.MAX_HISTORY) {
                this._history[key].shift();
            }
        });

        // Vérifier les seuils d'alerte
        this._checkAlerts(data);
    },

    // === Système d'alertes ===
    _alertCooldowns: {},
    _ALERT_COOLDOWN: 60000, // 1 minute entre chaque alerte du même type

    _checkAlerts(data) {
        if (typeof Toast === 'undefined') return;

        const now = Date.now();
        const fire = (key, msg) => {
            if (this._alertCooldowns[key] && now - this._alertCooldowns[key] < this._ALERT_COOLDOWN) return;
            this._alertCooldowns[key] = now;
            Toast.warn(msg, 6000);
            // Update badge
            this._alertCount = (this._alertCount || 0) + 1;
            const badge = document.getElementById('alert-badge');
            if (badge) { badge.textContent = this._alertCount; badge.style.display = 'flex'; }
        };

        // CPU > 95% pendant 3 mesures consécutives
        const cpuHist = this._history.cpu.slice(-3);
        if (cpuHist.length >= 3 && cpuHist.every(v => v > 95)) {
            fire('cpu_critical', `⚡ CPU critique : ${Math.round(data.cpu.percent)}% — Le processeur est surchargé`);
        }

        // RAM > 90%
        if (data.memory.percent > 90) {
            fire('ram_high', `🧠 RAM élevée : ${Math.round(data.memory.percent)}% — ${data.memory.used_gb}/${data.memory.total_gb} Go`);
        }

        // Disque > 95%
        if (data.disk.percent > 95) {
            fire('disk_full', `💾 Disque quasi plein : ${Math.round(data.disk.percent)}% — Libère de l'espace !`);
        }

        // Température CPU > 85°C
        if (data.temperature?.available && data.temperature.cpu_temp > 85) {
            fire('temp_high', `🌡️ Température CPU élevée : ${data.temperature.cpu_temp}°C`);
        }
    },
};

