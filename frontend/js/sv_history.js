/**
 * SvHistory — Historique d'activité du serveur.
 * Affiche les actions effectuées par les utilisateurs.
 */
const SvHistory = {
    _serverId: null,

    render(serverId) {
        this._serverId = serverId;
        setTimeout(() => this._load(), 50);
        return `
        <h2>${Lang.t('sv.hist.title')}</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.hist.desc')}</p>
        <div id="sv-hist-content"><div style="color:var(--text-muted)">⏳ ${Lang.t('common.loading')}</div></div>`;
    },

    async _load() {
        const el = document.getElementById('sv-hist-content');
        if (!el) return;

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/activity?limit=50`);
        if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger)">❌ ${Lang.t('common.error')}</div>`; return; }
        const data = await r.json();
        const entries = data.entries || [];

        if (entries.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);">${Lang.t('sv.hist.empty')}<br><span style="font-size:12px;">${Lang.t('sv.hist.empty_hint')}</span></div>`;
            return;
        }

        const icons = {start:'▶️',stop:'⏹',restart:'🔄',backup:'💾',console:'💻',settings:'⚙️',file:'📁',mod:'🧩'};
        const locale = Lang.t('common.locale') || 'fr-FR';

        el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="border-bottom:2px solid var(--border);text-align:left;">
                <th style="padding:8px;">${Lang.t('sv.hist.date')}</th>
                <th style="padding:8px;">${Lang.t('sv.hist.user')}</th>
                <th style="padding:8px;">${Lang.t('sv.hist.action')}</th>
                <th style="padding:8px;">${Lang.t('sv.hist.details')}</th>
            </tr></thead><tbody>
            ${entries.map(e => {
                const icon = Object.entries(icons).find(([k]) => e.action.toLowerCase().includes(k))?.[1] || '📌';
                const date = new Date(e.timestamp).toLocaleString(locale);
                return `<tr style="border-bottom:1px solid var(--border);">
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;white-space:nowrap;">${date}</td>
                    <td style="padding:8px;font-weight:600;">${e.username}</td>
                    <td style="padding:8px;">${icon} ${e.action}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:12px;">${e.details || '—'}</td>
                </tr>`;
            }).join('')}
            </tbody></table>`;
    },
};
