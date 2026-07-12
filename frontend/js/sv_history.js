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
        if (!r || !r.ok) { el.innerHTML = `<div style="color:var(--danger)">${Lang.t('common.error')}</div>`; return; }
        const data = await r.json();
        const entries = data.entries || [];

        if (entries.length === 0) {
            el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);">${Lang.t('sv.hist.empty')}<br><span style="font-size:12px;">${Lang.t('sv.hist.empty_hint')}</span></div>`;
            return;
        }

        const locale = Lang.t('common.locale') || 'fr-FR';

        // Ion v6 : feed mono .events-feed (composant Bento) + cascade .ev-in au chargement.
        // typ ok/warn/err déduit de l'action (sémantique fixe, indépendante de l'accent).
        el.innerHTML = `<div class="events-feed" style="max-height:420px;">
            ${entries.map((e, i) => {
                const a = (e.action || '').toLowerCase();
                const typ = /(err|fail|crash)/.test(a) ? 'err'
                    : /(stop|delete|suppr|ban|kick|arr)/.test(a) ? 'warn' : 'ok';
                const d = new Date(e.timestamp);
                const date = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
                    + ' ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                return `<div class="ev ev-in" style="animation-delay:${Math.min(i * 40, 400)}ms">
                    <span class="ts">${date}</span>
                    <span class="typ ${typ}">${esc(e.action)}</span>
                    <span class="msg"><b>${esc(e.username)}</b>${e.details ? ' · ' + esc(e.details) : ''}</span>
                </div>`;
            }).join('')}
            </div>`;
    },
};
