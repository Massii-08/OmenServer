/**
 * SvAccess — Onglet Accès style Minestrator.
 * Affiche les ports dédiés (gauche) et l'accès SFTP (droite).
 */
const SvAccess = {
    _serverId: null,
    _serverData: null,

    render(serverData, serverId) {
        this._serverId = serverId;
        this._serverData = serverData;
        setTimeout(() => this._loadPorts(), 50);
        return `
        <h2>🔌 Accès</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">Accédez aux identifiants SFTP et gérez les ports réseau</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
            <div>
                <h3 style="font-size:15px;margin-bottom:12px;">🔗 Ports dédiés</h3>
                <div id="sv-acc-ports"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>
            </div>
            <div>
                <h3 style="font-size:15px;margin-bottom:12px;">📂 Accès SFTP</h3>
                <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                        <span style="font-weight:600;">Connexion WinSCP / FileZilla</span>
                        <button class="btn btn-secondary btn-sm" onclick="SvAccess._copyAll()">📋 Copier tout</button>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Hôte / IP</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="navigator.clipboard.writeText('${GameServer._serverIP||'localhost'}')">
                                ${GameServer._serverIP||'localhost'} <span style="font-size:11px;color:var(--text-muted);">📋</span>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Port du serveur</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;">2222</div>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Nom d'utilisateur</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="navigator.clipboard.writeText('server_${serverId}')">
                                server_${serverId} <span style="font-size:11px;color:var(--text-muted);">📋</span>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Mot de passe</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;display:flex;justify-content:space-between;align-items:center;">
                                ••••••••
                                <span style="font-size:11px;color:var(--text-muted);cursor:pointer;" onclick="this.parentElement.querySelector('span:first-child')||0;alert('Utilise ton mot de passe OmenServer')">👁️</span>
                            </div>
                        </div>
                    </div>
                    <p style="color:var(--text-muted);font-size:11px;margin-top:12px;">⚠️ Le service SFTP doit être activé sur le serveur hôte.</p>
                </div>
            </div>
        </div>`;
    },

    async _loadPorts() {
        const el = document.getElementById('sv-acc-ports');
        if (!el) return;
        
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/ports`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Erreur</div>'; return; }
        
        const data = await r.json();
        const ports = data.ports || [];
        const serverIp = data.server_ip || GameServer._serverIP || 'localhost';
        
        if (ports.length === 0) {
            el.innerHTML = '<div style="color:var(--text-muted)">Aucun port exposé</div>';
            return;
        }
        
        el.innerHTML = ports.map(p => {
            const isMain = p.host_port === data.main_port;
            return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;${isMain?'border-left:3px solid var(--accent-green);':''}">
                <div>
                    <span style="font-family:monospace;font-weight:600;font-size:14px;">${serverIp} : ${p.host_port}</span>
                    ${isMain ? '<span style="font-size:10px;padding:2px 6px;background:var(--accent-green);color:#000;border-radius:4px;margin-left:8px;">Principal</span>' : ''}
                    <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${p.protocol.toUpperCase()}</span>
                </div>
                <div style="font-size:12px;color:var(--text-muted);">${p.description || ''}</div>
            </div>`;
        }).join('');
    },

    _copyAll() {
        const text = `Hôte: ${GameServer._serverIP||'localhost'}\nPort: 2222\nUtilisateur: server_${this._serverId}\nMot de passe: [ton mot de passe OmenServer]`;
        navigator.clipboard.writeText(text);
    },
};
