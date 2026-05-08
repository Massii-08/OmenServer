/**
 * SvMonitoring — Monitoring temps réel avec graphiques Canvas avancés.
 * 4 graphiques : CPU, RAM, Réseau ↓ et Réseau ↑ avec historique et stats.
 */
const SvMonitoring = {
    _serverId: null,
    _interval: null,
    _history: {cpu: [], ram: [], net_rx: [], net_tx: []},
    _timestamps: [],
    _maxPoints: 60,

    render(serverId) {
        this._serverId = serverId;
        this._history = {cpu: [], ram: [], net_rx: [], net_tx: []};
        this._timestamps = [];
        if (this._interval) clearInterval(this._interval);
        setTimeout(() => {
            ['sv-mon-cpu-chart','sv-mon-ram-chart','sv-mon-rx-chart','sv-mon-tx-chart'].forEach(id => {
                this._drawChart(id, [], '#555', 100, '%');
            });
            this._poll();
            this._interval = setInterval(() => this._poll(), 3000);
        }, 200);
        return `
        <h2>${Lang.t('sv.mon.title')}</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.mon.desc')}</p>

        <div id="sv-mon-status" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;border-top:3px solid var(--accent-blue);">
                <div style="font-size:11px;color:var(--text-muted);">⚡ CPU</div>
                <div id="sv-mon-cpu" style="font-size:24px;font-weight:700;color:var(--accent-blue);">—</div>
                <div id="sv-mon-cpu-info" style="font-size:10px;color:var(--text-muted);margin-top:2px;">—</div>
            </div>
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;border-top:3px solid var(--accent-green);">
                <div style="font-size:11px;color:var(--text-muted);">🧠 RAM</div>
                <div id="sv-mon-ram" style="font-size:24px;font-weight:700;color:var(--accent-green);">—</div>
                <div id="sv-mon-ram-info" style="font-size:10px;color:var(--text-muted);margin-top:2px;">—</div>
            </div>
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;border-top:3px solid #f59e0b;">
                <div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.mon.net_in')}</div>
                <div id="sv-mon-rx" style="font-size:24px;font-weight:700;color:#f59e0b;">—</div>
            </div>
            <div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center;border-top:3px solid #a78bfa;">
                <div style="font-size:11px;color:var(--text-muted);">${Lang.t('sv.mon.net_out')}</div>
                <div id="sv-mon-tx" style="font-size:24px;font-weight:700;color:#a78bfa;">—</div>
            </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:13px;font-weight:600;">⚡ CPU</span>
                    <span id="sv-mon-cpu-peak" style="font-size:10px;color:var(--text-muted);">${Lang.t('sv.mon.peak')}: —</span>
                </div>
                <canvas id="sv-mon-cpu-chart" height="180"></canvas>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:13px;font-weight:600;">🧠 RAM</span>
                    <span id="sv-mon-ram-peak" style="font-size:10px;color:var(--text-muted);">${Lang.t('sv.mon.peak')}: —</span>
                </div>
                <canvas id="sv-mon-ram-chart" height="180"></canvas>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:13px;font-weight:600;">${Lang.t('sv.mon.net_in_label')}</span>
                    <span id="sv-mon-rx-total" style="font-size:10px;color:var(--text-muted);">total: —</span>
                </div>
                <canvas id="sv-mon-rx-chart" height="140"></canvas>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:13px;font-weight:600;">${Lang.t('sv.mon.net_out_label')}</span>
                    <span id="sv-mon-tx-total" style="font-size:10px;color:var(--text-muted);">total: —</span>
                </div>
                <canvas id="sv-mon-tx-chart" height="140"></canvas>
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
            if (cpuEl) cpuEl.textContent = d.status === 'stopped' ? Lang.t('sv.mon.stopped') : '—';
            return;
        }

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setVal('sv-mon-cpu', d.cpu_percent.toFixed(1) + '%');
        setVal('sv-mon-ram', d.ram_used_mb + ' Mo');
        setVal('sv-mon-rx', d.net_rx_mb + ' Mo');
        setVal('sv-mon-tx', d.net_tx_mb + ' Mo');

        const now = new Date();
        this._timestamps.push(now);
        this._history.cpu.push(d.cpu_percent);
        this._history.ram.push(d.ram_percent || (d.ram_used_mb / (d.ram_limit_mb || 2048) * 100));
        this._history.net_rx.push(d.net_rx_mb || 0);
        this._history.net_tx.push(d.net_tx_mb || 0);

        while (this._timestamps.length > this._maxPoints) {
            this._timestamps.shift();
            this._history.cpu.shift();
            this._history.ram.shift();
            this._history.net_rx.shift();
            this._history.net_tx.shift();
        }

        const avg = arr => arr.length ? (arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(1) : '—';
        const peak = arr => arr.length ? Math.max(...arr).toFixed(1) : '—';

        setVal('sv-mon-cpu-info', `${Lang.t('sv.mon.avg')}: ${avg(this._history.cpu)}% · ${this._history.cpu.length} pts`);
        setVal('sv-mon-ram-info', `${d.ram_used_mb}/${d.ram_limit_mb || '?'} Mo`);
        setVal('sv-mon-cpu-peak', `${Lang.t('sv.mon.peak')}: ${peak(this._history.cpu)}%`);
        setVal('sv-mon-ram-peak', `${Lang.t('sv.mon.peak')}: ${peak(this._history.ram)}%`);
        setVal('sv-mon-rx-total', `total: ${d.net_rx_mb} Mo`);
        setVal('sv-mon-tx-total', `total: ${d.net_tx_mb} Mo`);

        this._drawChart('sv-mon-cpu-chart', this._history.cpu, '#3b82f6', 100, '%');
        this._drawChart('sv-mon-ram-chart', this._history.ram, '#22c55e', 100, '%');

        const rxDeltas = this._calcDeltas(this._history.net_rx);
        const txDeltas = this._calcDeltas(this._history.net_tx);
        const maxNet = Math.max(0.01, Math.max(...rxDeltas, ...txDeltas));
        this._drawChart('sv-mon-rx-chart', rxDeltas, '#f59e0b', maxNet, ' Mo');
        this._drawChart('sv-mon-tx-chart', txDeltas, '#a78bfa', maxNet, ' Mo');
    },

    _calcDeltas(arr) {
        if (arr.length < 2) return arr.slice();
        const deltas = [0];
        for (let i = 1; i < arr.length; i++) {
            deltas.push(Math.max(0, arr[i] - arr[i-1]));
        }
        return deltas;
    },

    _drawChart(canvasId, data, color, maxVal, unit) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;
        if (w === 0 || h === 0) return;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);

        if (data.length < 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.font = '12px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(Lang.t('sv.mon.waiting'), w / 2, h / 2);
            return;
        }

        const pad = {top: 10, right: 10, bottom: 22, left: 42};
        const cw = w - pad.left - pad.right;
        const ch = h - pad.top - pad.bottom;

        ctx.font = '10px Inter, monospace';
        ctx.textAlign = 'right';
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (ch * i / 4);
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            const label = maxVal <= 1 ? (maxVal - (maxVal * i / 4)).toFixed(2) : Math.round(maxVal - (maxVal * i / 4));
            ctx.fillText(label + unit, pad.left - 4, y + 3);
        }

        const locale = Lang.t('common.locale') || 'fr-FR';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        const timeLabels = [0, Math.floor(data.length / 2), data.length - 1];
        for (const i of timeLabels) {
            if (i < this._timestamps.length) {
                const t = this._timestamps[i];
                const x = pad.left + (i / (this._maxPoints - 1)) * cw;
                ctx.fillText(t.toLocaleTimeString(locale, {hour:'2-digit', minute:'2-digit', second:'2-digit'}), x, h - 4);
            }
        }

        const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
        grad.addColorStop(0, color + '30');
        grad.addColorStop(1, color + '05');

        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top + ch);
        for (let i = 0; i < data.length; i++) {
            const x = pad.left + (i / (this._maxPoints - 1)) * cw;
            const y = pad.top + ch - (Math.min(data[i], maxVal) / maxVal) * ch;
            if (i === 0) ctx.lineTo(x, y);
            else {
                const prevX = pad.left + ((i-1) / (this._maxPoints - 1)) * cw;
                const prevY = pad.top + ch - (Math.min(data[i-1], maxVal) / maxVal) * ch;
                const cpx = (prevX + x) / 2;
                ctx.bezierCurveTo(cpx, prevY, cpx, y, x, y);
            }
        }
        ctx.lineTo(pad.left + ((data.length - 1) / (this._maxPoints - 1)) * cw, pad.top + ch);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = pad.left + (i / (this._maxPoints - 1)) * cw;
            const y = pad.top + ch - (Math.min(data[i], maxVal) / maxVal) * ch;
            if (i === 0) ctx.moveTo(x, y);
            else {
                const prevX = pad.left + ((i-1) / (this._maxPoints - 1)) * cw;
                const prevY = pad.top + ch - (Math.min(data[i-1], maxVal) / maxVal) * ch;
                const cpx = (prevX + x) / 2;
                ctx.bezierCurveTo(cpx, prevY, cpx, y, x, y);
            }
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        if (data.length > 0) {
            const lastX = pad.left + ((data.length - 1) / (this._maxPoints - 1)) * cw;
            const lastY = pad.top + ch - (Math.min(data[data.length - 1], maxVal) / maxVal) * ch;

            ctx.beginPath();
            ctx.arc(lastX, lastY, 8, 0, Math.PI * 2);
            ctx.fillStyle = color + '20';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#0f0f1a';
            ctx.lineWidth = 2;
            ctx.stroke();

            const val = maxVal <= 1 ? data[data.length-1].toFixed(3) : data[data.length-1].toFixed(1);
            ctx.fillStyle = color;
            ctx.font = 'bold 11px Inter, monospace';
            ctx.textAlign = 'left';
            const labelX = lastX + 10 > w - 50 ? lastX - 45 : lastX + 10;
            ctx.fillText(val + unit, labelX, lastY + 4);
        }
    },
};
