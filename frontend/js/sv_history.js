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
        <h2>📜 Historique d'activité</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Journal des actions effectuées sur ce serveur</p>
        <div id="sv-hist-content"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>`;
    },

    async _load() {
        const el = document.getElementById('sv-hist-content');
        if (!el) return;

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/activity?limit=50`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Erreur</div>'; return; }
        const data = await r.json();
        const entries = data.entries || [];

        if (entries.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Aucune activité enregistrée pour le moment.<br><span style="font-size:12px;">Les actions (start, stop, backup...) apparaîtront ici.</span></div>';
            return;
        }

        const icons = {start:'▶️',stop:'⏹',restart:'🔄',backup:'💾',console:'💻',settings:'⚙️',file:'📁',mod:'🧩'};

        el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="border-bottom:2px solid var(--border-color);text-align:left;">
                <th style="padding:8px;">Date</th>
                <th style="padding:8px;">Utilisateur</th>
                <th style="padding:8px;">Action</th>
                <th style="padding:8px;">Détails</th>
            </tr></thead><tbody>
            ${entries.map(e => {
                const icon = Object.entries(icons).find(([k]) => e.action.toLowerCase().includes(k))?.[1] || '📌';
                const date = new Date(e.timestamp).toLocaleString('fr-FR');
                return `<tr style="border-bottom:1px solid var(--border-color);">
                    <td style="padding:8px;color:var(--text-muted);font-size:11px;white-space:nowrap;">${date}</td>
                    <td style="padding:8px;font-weight:600;">${e.username}</td>
                    <td style="padding:8px;">${icon} ${e.action}</td>
                    <td style="padding:8px;color:var(--text-muted);font-size:12px;">${e.details || '—'}</td>
                </tr>`;
            }).join('')}
            </tbody></table>`;
    },
};
