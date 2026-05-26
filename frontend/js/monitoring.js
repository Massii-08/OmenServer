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
        this._fetchHostname(); // Récupérer le hostname du serveur une seule fois
        this.fetchStats(); // Premier appel immédiat
        this._intervalId = setInterval(() =>this.fetchStats(), this.REFRESH_INTERVAL);
    },

    /**
     * Récupère le hostname du serveur principal (une seule fois).
     * Cache aussi l'OS et l'uptime pour la carte Omen.
     */
    async _fetchHostname() {
        const r = await Auth.apiCall('/api/monitoring/system');
        if (r && r.ok) {
            const data = await r.json();
            this._serverHostname = data.hostname || 'Omen';
            this._serverOS = data.os || 'Linux';
            this._serverUptime = data.uptime_hours || 0;
        }
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
        this._lastServerData = data; // Cache pour la carte Omen
        this.updateUI(data);
        this.updateHistory(data);

        // Nodes: rafraîchir toutes les 2 cycles (~4s)
        this._nodesCycle = (this._nodesCycle || 0) + 1;
        if (this._nodesCycle % 2 === 0) {
            this.fetchNodes();
        }

        // Re-fetch uptime toutes les ~60s (30 cycles * 2s)
        if (this._nodesCycle % 30 === 0) {
            this._fetchHostname();
        }
    },

    /**
     * Récupère la liste des PC connectés et met à jour le dashboard.
     */
    async fetchNodes() {
        const r = await Auth.apiCall('/api/nodes');
        if (!r || !r.ok) return;

        const nodes = await r.json();
        this._lastNodes = nodes; // Cache pour calculs combinés
        this.renderNodes(nodes);
    },

    /**
     * Affiche les cartes des PC connectés dans le dashboard.
     * Le serveur Omen (cerveau) est TOUJOURS affiché en premier,
     * suivi des agents (bras).
     */
    renderNodes(nodes) {
        const grid = document.getElementById('nodes-grid');
        const countEl = document.getElementById('nodes-count');
        if (!grid) return;

        const serverData = this._lastServerData;
        const serverHostname = this._serverHostname || 'Omen';
        const agentNodes = nodes || [];
        const onlineAgents = agentNodes.filter(n =>n.online).length;
        const totalCount = 1 + agentNodes.length;
        const onlineCount = 1 + onlineAgents; // Omen is always online

        if (countEl) {
            countEl.textContent = `(${onlineCount}/${totalCount})`;
        }

        // Helpers (Bento Tech — no progress bars, value class encodes severity)
        const sev = (v) =>v >90 ? 'danger' : v >70 ? 'warn' : '';
        const fmtUptime = (h) =>{
            if (h == null) return '';
            if (h < 1) return `${Math.round(h * 60)}m`;
            if (h < 24) return `${Math.round(h)}h`;
            return `${Math.round(h / 24)}j ${Math.round(h % 24)}h`;
        };
        const fmtOfflineSince = (secs) =>{
            if (secs < 60) return `${Math.round(secs)}s`;
            if (secs < 3600) return `${Math.round(secs / 60)}m`;
            return `${Math.round(secs / 3600)}h`;
        };
        const isAdmin = !!Auth.getUser()?.is_admin;

        // === Omen (brain) — always first ===
        let omenCard = '';
        if (serverData) {
            const cpu = serverData.cpu;
            const mem = serverData.memory;
            const disk = serverData.disk;
            const temp = serverData.temperature;
            const uptimeText = fmtUptime(this._serverUptime);

            omenCard = `
                <div class="machine-card brain">
                    <div class="m-head">
                        <span class="dot"></span>
                        <span class="name">${serverHostname}</span>
                        <span class="role">${this._serverOS || 'Linux'}</span>
                    </div>
                    <div class="m-stats">
                        <div class="m-stat"><div class="l">CPU ${cpu.count}c</div><div class="v ${sev(cpu.percent)}">${Math.round(cpu.percent)}%</div></div>
                        <div class="m-stat"><div class="l">RAM</div><div class="v ${sev(mem.percent)}">${mem.used_gb}/${mem.total_gb} Go</div></div>
                        <div class="m-stat"><div class="l">Disk</div><div class="v ${sev(disk.percent)}">${disk.used_gb}/${disk.total_gb} Go</div></div>
                    </div>
                    <div class="m-meta">
                        <span>${temp && temp.available ? `${temp.cpu_temp}°C` : '—'}</span>
                        <span>${uptimeText ? `${uptimeText} ${Lang.t('nodes.uptime')}` : ''}</span>
                    </div>
                    ${isAdmin ? `
                    <div class="m-actions">
                        <button class="btn btn-sm btn-secondary" onclick="Monitoring.omenPowerAction('reboot')" title="${Lang.t('nodes.omen_reboot_desc')}">${Lang.t('nodes.reboot')}</button>
                        <button class="btn btn-sm btn-danger" onclick="Monitoring.omenPowerAction('shutdown')" title="${Lang.t('nodes.omen_shutdown_desc')}">${Lang.t('nodes.shutdown')}</button>
                    </div>
                    ` : ''}
                </div>`;
        }

        // === Agents (arms) ===
        const agentCards = agentNodes.map(node =>{
            const uptimeText = fmtUptime(node.uptime_hours);
            const offlineText = node.online
                ? ''
                : `${Lang.t('nodes.since')} ${fmtOfflineSince(node.last_seen_seconds_ago)}`;

            return `
                <div class="machine-card arm ${node.online ? '' : 'offline'}">
                    <div class="m-head">
                        <span class="dot"></span>
                        <span class="name">${node.hostname}</span>
                        <span class="role">${node.os}</span>
                    </div>
                    ${node.online ? `
                    <div class="m-stats">
                        <div class="m-stat"><div class="l">CPU ${node.cpu_count}c</div><div class="v ${sev(node.cpu_percent)}">${Math.round(node.cpu_percent)}%</div></div>
                        <div class="m-stat"><div class="l">RAM</div><div class="v ${sev(node.ram_percent)}">${node.ram_used_gb}/${node.ram_total_gb} Go</div></div>
                        <div class="m-stat"><div class="l">Disk</div><div class="v ${sev(node.disk_percent)}">${node.disk_used_gb}/${node.disk_total_gb} Go</div></div>
                    </div>
                    <div class="m-meta">
                        <span>${node.temperature ? `${node.temperature}°C` : '—'}</span>
                        <span>${uptimeText ? `${uptimeText} ${Lang.t('nodes.uptime')}` : ''}</span>
                    </div>
                    ${isAdmin ? `
                    <div class="m-actions">
                        <button class="btn btn-sm btn-secondary" onclick="Monitoring.nodeAction('${node.hostname}', 'reboot')" title="${Lang.t('nodes.reboot_desc')}">${Lang.t('nodes.reboot')}</button>
                        <button class="btn btn-sm btn-secondary" onclick="Monitoring.nodeAction('${node.hostname}', 'shutdown')" title="${Lang.t('nodes.shutdown_desc')}">${Lang.t('nodes.shutdown')}</button>
                        <div style="flex:1;"></div>
                        <button class="btn btn-sm btn-secondary" onclick="Monitoring.removeNode('${node.hostname}')" title="${Lang.t('nodes.remove')}"></button>
                    </div>
                    ` : ''}
                    ` : `
                    <div class="m-offline-msg">
                        ${Lang.t('nodes.offline')} · ${offlineText}
                    </div>
                    ${isAdmin ? `
                    <div class="m-actions">
                        <button class="btn btn-sm btn-secondary" onclick="Monitoring.removeNode('${node.hostname}')" title="${Lang.t('nodes.remove')}">${Lang.t('nodes.remove')}</button>
                    </div>
                    ` : ''}
                    `}
                </div>`;
        }).join('');

        grid.innerHTML = omenCard + agentCards;
    },

    /**
     * Envoie une commande à distance (reboot/shutdown) à un PC.
     */
    async nodeAction(hostname, action) {
        const actionLabel = action === 'reboot' ? Lang.t('nodes.reboot') : Lang.t('nodes.shutdown');
        const confirmKey = action === 'reboot' ? 'nodes.reboot_confirm' : 'nodes.shutdown_confirm';
        if (!confirm(Lang.t(confirmKey).replace('{name}', hostname))) return;

        const r = await Auth.apiCall(`/api/nodes/${encodeURIComponent(hostname)}/${action}`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        if (r && r.ok) {
            const data = await r.json();
            if (typeof Toast !== 'undefined') Toast.success(data.message);
        } else {
            const err = r ? await r.json().catch(() =>({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
        }
    },

    /**
     * Retire un PC de la liste des nodes.
     */
    async removeNode(hostname) {
        if (!confirm(Lang.t('nodes.remove_confirm'))) return;

        const r = await Auth.apiCall(`/api/nodes/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
        if (r && r.ok) {
            if (typeof Toast !== 'undefined') Toast.success(`${hostname} retiré`);
            this.fetchNodes(); // Refresh
        } else {
            const err = r ? await r.json().catch(() =>({})) : {};
            if (typeof Toast !== 'undefined') Toast.error(err.detail || Lang.t('common.error'));
        }
    },

    /**
     * Reboot ou shutdown du serveur Omen (cerveau).
     * Double confirmation car c'est le serveur principal.
     * Envoie un body JSON vide pour éviter les problèmes avec Cloudflare/proxy.
     */
    async omenPowerAction(action) {
        const actionLabel = action === 'reboot' ? Lang.t('nodes.reboot') : Lang.t('nodes.shutdown');
        const hostname = this._serverHostname || 'Omen';

        // Première confirmation
        const confirmKey = action === 'reboot' ? 'nodes.omen_reboot_confirm' : 'nodes.omen_shutdown_confirm';
        if (!confirm(Lang.t(confirmKey).replace('{name}', hostname))) return;

        // Double confirmation pour le shutdown (extinction totale)
        if (action === 'shutdown') {
            if (!confirm(Lang.t('nodes.omen_shutdown_final'))) return;
        }

        // Envoyer la commande — body JSON vide obligatoire pour Cloudflare
        try {
            const r = await Auth.apiCall(`/api/power/${action}`, {
                method: 'POST',
                body: JSON.stringify({}),
            });
            if (r && r.ok) {
                const data = await r.json();
                if (typeof Toast !== 'undefined') {
                    Toast.success(data.message || `${actionLabel} ${Lang.t('nodes.power_sent')}`, 10000);
                }
                // Arrêter le monitoring pour éviter les fausses alertes de déconnexion
                this.stop();
                if (typeof NetworkModule !== 'undefined' && NetworkModule._refreshInterval) {
                    clearInterval(NetworkModule._refreshInterval);
                    NetworkModule._refreshInterval = null;
                }
            } else {
                const err = r ? await r.json().catch(() =>({})) : {};
                const detail = err.detail || Lang.t('common.error');
                console.error(`[Power] ${action} failed:`, detail);
                if (typeof Toast !== 'undefined') Toast.error(`${actionLabel}: ${detail}`, 8000);
            }
        } catch (e) {
            console.error(`[Power] ${action} exception:`, e);
            if (typeof Toast !== 'undefined') Toast.error(`${actionLabel}: ${e.message}`, 8000);
        }
    },

    updateUI(data) {
        // Récupérer les nodes en cache pour le calcul combiné
        const nodes = this._lastNodes || [];
        const onlineNodes = nodes.filter(n =>n.online);
        const serverHostname = this._serverHostname || 'Omen';

        // --- CPU : moyenne pondérée par nombre de cœurs ---
        let totalCores = data.cpu.count || 1;
        let weightedCpu = data.cpu.percent * totalCores;
        for (const node of onlineNodes) {
            const cores = node.cpu_count || 1;
            totalCores += cores;
            weightedCpu += (node.cpu_percent || 0) * cores;
        }
        const combinedCpu = totalCores >0 ? Math.round((weightedCpu / totalCores) * 10) / 10 : data.cpu.percent;
        this.updateStat('cpu', combinedCpu, '%');

        // --- RAM : somme de toutes les machines ---
        let totalRamGb = data.memory.total_gb;
        let usedRamGb = data.memory.used_gb;
        for (const node of onlineNodes) {
            totalRamGb += (node.ram_total_gb || 0);
            usedRamGb += (node.ram_used_gb || 0);
        }
        const combinedRamPercent = totalRamGb >0
            ? Math.round((usedRamGb / totalRamGb) * 1000) / 10
            : data.memory.percent;
        this.updateStat('memory', combinedRamPercent, '%',
            `${Math.round(usedRamGb * 10) / 10} / ${Math.round(totalRamGb * 10) / 10} Go`);

        // --- DISQUE : combiner serveur + tous les nodes online ---
        let totalDiskGb = data.disk.total_gb;
        let usedDiskGb = data.disk.used_gb;
        for (const node of onlineNodes) {
            totalDiskGb += (node.disk_total_gb || 0);
            usedDiskGb += (node.disk_used_gb || 0);
        }
        const combinedDiskPercent = totalDiskGb >0
            ? Math.round((usedDiskGb / totalDiskGb) * 1000) / 10
            : 0;
        this.updateStat('disk', combinedDiskPercent, '%',
            `${Math.round(usedDiskGb * 10) / 10} / ${Math.round(totalDiskGb * 10) / 10} Go`);

        // --- Température : max de toutes les machines ---
        let maxTemp = data.temperature.available ? data.temperature.cpu_temp : 0;
        let tempAvailable = data.temperature.available;
        for (const node of onlineNodes) {
            if (node.temperature) {
                maxTemp = Math.max(maxTemp, node.temperature);
                tempAvailable = true;
            }
        }
        if (tempAvailable) {
            this.updateStat('temp', maxTemp, '°C');
        } else {
            const tempValue = document.getElementById('stat-temp-value');
            if (tempValue) tempValue.textContent = 'N/A';
        }

        // --- Réseau ---
        const netEl = document.getElementById('stat-network');
        if (netEl) {
            netEl.textContent = `↑ ${data.network.bytes_sent_mb} Mo  ↓ ${data.network.bytes_recv_mb} Mo`;
        }

        // --- Mini-listes par machine ---
        this._renderMachinesList('cpu', serverHostname, data, onlineNodes);
        this._renderMachinesList('memory', serverHostname, data, onlineNodes);
        this._renderMachinesList('disk', serverHostname, data, onlineNodes);
        this._renderMachinesList('temp', serverHostname, data, onlineNodes);
    },

    /**
     * Affiche la mini-liste des machines dans une carte de stat.
     */
    _renderMachinesList(type, serverHostname, serverData, onlineNodes) {
        const container = document.getElementById(`stat-${type}-machines`);
        if (!container) return;

        // Ne rien afficher s'il n'y a pas de nodes
        if (!onlineNodes || onlineNodes.length === 0) {
            container.innerHTML = '';
            return;
        }

        // Construire la liste des machines (serveur + nodes)
        let items = [];

        if (type === 'cpu') {
            items.push({ name: serverHostname, value: `${Math.round(serverData.cpu.percent)}%`, cores: serverData.cpu.count });
            for (const n of onlineNodes) {
                items.push({ name: n.hostname, value: `${Math.round(n.cpu_percent)}%`, cores: n.cpu_count });
            }
        } else if (type === 'memory') {
            items.push({ name: serverHostname, value: `${serverData.memory.used_gb}/${serverData.memory.total_gb} Go` });
            for (const n of onlineNodes) {
                items.push({ name: n.hostname, value: `${n.ram_used_gb}/${n.ram_total_gb} Go` });
            }
        } else if (type === 'disk') {
            // Afficher le détail du serveur (avec les partitions)
            const serverDiskLabel = `${serverData.disk.used_gb}/${serverData.disk.total_gb} Go`;
            items.push({ name: serverHostname, value: serverDiskLabel });
            for (const n of onlineNodes) {
                items.push({ name: n.hostname, value: `${n.disk_used_gb}/${n.disk_total_gb} Go` });
            }
        } else if (type === 'temp') {
            if (serverData.temperature.available) {
                items.push({ name: serverHostname, value: `${serverData.temperature.cpu_temp}°C` });
            }
            for (const n of onlineNodes) {
                if (n.temperature) {
                    items.push({ name: n.hostname, value: `${n.temperature}°C` });
                }
            }
            if (items.length === 0) return;
        }

        container.innerHTML = items.map(item =>`
            <div class="stat-machine-item">
                <span class="stat-machine-name">${item.name}</span>
                <span class="stat-machine-value">${item.value}${item.cores ? ` <span style="opacity:0.5">(${item.cores}c)</span>` : ''}</span>
            </div>
        `).join('');
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
            if (value >90) barEl.style.background = 'var(--danger)';
            else if (value >70) barEl.style.background = 'var(--warning)';
            else barEl.style.background = 'var(--stat-color, var(--accent))';
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
        Object.keys(this._history).forEach(key =>{
            if (this._history[key].length >this.MAX_HISTORY) {
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
        const fire = (key, msg) =>{
            if (this._alertCooldowns[key] && now - this._alertCooldowns[key] < this._ALERT_COOLDOWN) return;
            this._alertCooldowns[key] = now;
            Toast.warn(msg, 6000);
            // Update badge
            this._alertCount = (this._alertCount || 0) + 1;
            const badge = document.getElementById('alert-badge');
            if (badge) { badge.textContent = this._alertCount; badge.style.display = 'flex'; }
        };

        // CPU >95% pendant 3 mesures consécutives
        const cpuHist = this._history.cpu.slice(-3);
        if (cpuHist.length >= 3 && cpuHist.every(v =>v >95)) {
            fire('cpu_critical', `CPU critique : ${Math.round(data.cpu.percent)}% — Le processeur est surchargé`);
        }

        // RAM >90%
        if (data.memory.percent >90) {
            fire('ram_high', ` RAM élevée : ${Math.round(data.memory.percent)}% — ${data.memory.used_gb}/${data.memory.total_gb} Go`);
        }

        // Disque >95%
        if (data.disk.percent >95) {
            fire('disk_full', `Disque quasi plein : ${Math.round(data.disk.percent)}% — Libère de l'espace !`);
        }

        // Température CPU >85°C
        if (data.temperature?.available && data.temperature.cpu_temp >85) {
            fire('temp_high', ` Température CPU élevée : ${data.temperature.cpu_temp}°C`);
        }
    },
};

