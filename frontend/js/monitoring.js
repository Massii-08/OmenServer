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
    },

    /**
     * Met à jour les éléments HTML avec les nouvelles données.
     */
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
    },
};
