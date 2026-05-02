/**
 * SvMonitoring — Monitoring temps réel avec graphiques Canvas.
 * Affiche CPU, RAM et Réseau en temps réel avec historique.
 */
const SvMonitoring = {
    _serverId: null,
    _interval: null,
    _history: {cpu: [], ram: [], net_rx: [], net_tx: []},
    _maxPoints: 60,

    render(serverId) {
        this._serverId = serverId;
        this._history = {cpu: [], ram: [], net_rx: [], net_tx: []};
        if (this._interval) clearInterval(this._interval);
        setTimeout(() => {
            this._poll();
            this._interval = setInterval(() => this._poll(), 3000);
        }, 100);
        return `
        <h2>📈 Monitoring temps réel</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Statistiques en direct du conteneur Docker</p>
        <div id="sv-mon-status" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;">
                <div style="font-size:11px;color:var(--text-muted);">CPU</div>
                <div id="sv-mon-cpu" style="font-size:24px;font-weight:700;color:var(--accent-blue);">—</div>
            </div>
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;">
                <div style="font-size:11px;color:var(--text-muted);">RAM</div>
                <div id="sv-mon-ram" style="font-size:24px;font-weight:700;color:var(--accent-green);">—</div>
            </div>
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;">
                <div style="font-size:11px;color:var(--text-muted);">Réseau ↓</div>
                <div id="sv-mon-rx" style="font-size:24px;font-weight:700;color:var(--accent-orange);">—</div>
            </div>
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;">
                <div style="font-size:11px;color:var(--text-muted);">Réseau ↑</div>
                <div id="sv-mon-tx" style="font-size:24px;font-weight:700;color:#a78bfa;">—</div>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:13px;font-weight:600;margin-bottom:8px;">⚡ CPU</div>
                <canvas id="sv-mon-cpu-chart" height="150"></canvas>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:13px;font-weight:600;margin-bottom:8px;">💻 RAM</div>
                <canvas id="sv-mon-ram-chart" height="150"></canvas>
            </div>
        </div>`;
    },

    stop() {
        if (this._interval) { clearInterval(this._interval); this._interval = null; }
    },

    async _poll() {
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/stats`);
        if (!r || !r.ok) return;
        const d = await r.json();
        if (d.error || d.status === 'stopped') {
            const cpuEl = document.getElementById('sv-mon-cpu');
            if (cpuEl) cpuEl.textContent = d.status === 'stopped' ? 'Arrêté' : '—';
            return;
        }

        // Mettre à jour les valeurs
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setVal('sv-mon-cpu', d.cpu_percent.toFixed(1) + '%');
        setVal('sv-mon-ram', d.ram_used_mb + ' Mo');
        setVal('sv-mon-rx', d.net_rx_mb + ' Mo');
        setVal('sv-mon-tx', d.net_tx_mb + ' Mo');

        // Historique
        this._history.cpu.push(d.cpu_percent);
        this._history.ram.push(d.ram_percent);
        if (this._history.cpu.length > this._maxPoints) this._history.cpu.shift();
        if (this._history.ram.length > this._maxPoints) this._history.ram.shift();

        // Dessiner
        this._drawChart('sv-mon-cpu-chart', this._history.cpu, '#3b82f6', 100, '%');
        this._drawChart('sv-mon-ram-chart', this._history.ram, '#22c55e', 100, '%');
    },

    _drawChart(canvasId, data, color, maxVal, unit) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || data.length < 2) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width = canvas.offsetWidth;
        const h = canvas.height = canvas.offsetHeight;
        const pad = {top: 10, right: 10, bottom: 20, left: 40};
        const cw = w - pad.left - pad.right;
        const ch = h - pad.top - pad.bottom;

        ctx.clearRect(0, 0, w, h);

        // Grille
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (ch * i / 4);
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(Math.round(maxVal - (maxVal * i / 4)) + unit, pad.left - 4, y + 3);
        }

        // Remplissage gradient
        const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
        grad.addColorStop(0, color + '40');
        grad.addColorStop(1, color + '05');

        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top + ch);
        for (let i = 0; i < data.length; i++) {
            const x = pad.left + (i / (this._maxPoints - 1)) * cw;
            const y = pad.top + ch - (Math.min(data[i], maxVal) / maxVal) * ch;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(pad.left + ((data.length - 1) / (this._maxPoints - 1)) * cw, pad.top + ch);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Ligne
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = pad.left + (i / (this._maxPoints - 1)) * cw;
            const y = pad.top + ch - (Math.min(data[i], maxVal) / maxVal) * ch;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Point courant
        if (data.length > 0) {
            const lastX = pad.left + ((data.length - 1) / (this._maxPoints - 1)) * cw;
            const lastY = pad.top + ch - (Math.min(data[data.length - 1], maxVal) / maxVal) * ch;
            ctx.beginPath();
            ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    },
};
