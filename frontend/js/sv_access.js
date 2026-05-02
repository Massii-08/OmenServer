/**
 * SvAccess — Onglet Accès style Minestrator.
 * Ports dédiés (avec ajout/suppression) + Accès SFTP (avec bouton WinSCP).
 */
const SvAccess = {
    _serverId: null,
    _serverData: null,

    render(serverData, serverId) {
        this._serverId = serverId;
        this._serverData = serverData;
        setTimeout(() => this._loadPorts(), 50);
        const ip = GameServer._serverIP || 'localhost';
        const user = `server_${serverId}`;

        return `
        <h2>🔌 Accès</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">Accédez aux identifiants SFTP et gérez les ports réseau</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">

            <!-- COLONNE GAUCHE : Ports dédiés -->
            <div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <h3 style="font-size:15px;margin:0;">🔗 Ports dédiés</h3>
                    <button class="btn btn-primary btn-sm" onclick="SvAccess._showAddPort()">➕ Ajouter un port</button>
                </div>
                <div id="sv-acc-add-form" style="display:none;background:var(--bg-secondary);padding:14px;border-radius:8px;margin-bottom:12px;">
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
                        <div>
                            <label style="font-size:11px;color:var(--text-muted);">Port hôte</label>
                            <input type="number" id="sv-acc-host-port" class="form-input" placeholder="ex: 8080" min="1024" max="65535" style="margin-top:4px;" />
                        </div>
                        <div>
                            <label style="font-size:11px;color:var(--text-muted);">Port conteneur</label>
                            <input type="number" id="sv-acc-cont-port" class="form-input" placeholder="ex: 8080" min="1" max="65535" style="margin-top:4px;" />
                        </div>
                        <div>
                            <label style="font-size:11px;color:var(--text-muted);">Protocole</label>
                            <select id="sv-acc-proto" class="form-input" style="margin-top:4px;">
                                <option value="tcp">TCP</option>
                                <option value="udp">UDP</option>
                            </select>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <button class="btn btn-primary btn-sm" onclick="SvAccess._addPort()">✅ Ajouter</button>
                        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('sv-acc-add-form').style.display='none'">Annuler</button>
                        <span id="sv-acc-msg" style="font-size:12px;"></span>
                    </div>
                    <p style="font-size:10px;color:var(--text-muted);margin-top:8px;">⚠️ Le conteneur sera brièvement redémarré pour appliquer le changement.</p>
                </div>
                <div id="sv-acc-ports"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>
            </div>

            <!-- COLONNE DROITE : Accès SFTP -->
            <div>
                <h3 style="font-size:15px;margin-bottom:12px;">📂 Accès SFTP</h3>
                <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                        <span style="font-weight:600;">Connexion WinSCP / FileZilla</span>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Hôte / IP</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="navigator.clipboard.writeText('${ip}');this.querySelector('.cp').textContent='✅';setTimeout(()=>this.querySelector('.cp').textContent='📋',1500)">
                                sftp://${ip} <span class="cp" style="font-size:11px;color:var(--text-muted);">📋</span>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Port du serveur</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="navigator.clipboard.writeText('2222');this.querySelector('.cp').textContent='✅';setTimeout(()=>this.querySelector('.cp').textContent='📋',1500)">
                                2222 <span class="cp" style="font-size:11px;color:var(--text-muted);">📋</span>
                            </div>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Nom d'utilisateur</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;" onclick="navigator.clipboard.writeText('${user}');this.querySelector('.cp').textContent='✅';setTimeout(()=>this.querySelector('.cp').textContent='📋',1500)">
                                ${user} <span class="cp" style="font-size:11px;color:var(--text-muted);">📋</span>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Mot de passe</div>
                            <div class="form-input" style="font-family:monospace;font-size:13px;display:flex;justify-content:space-between;align-items:center;">
                                <span id="sv-sftp-pw">••••••••</span>
                                <span style="font-size:11px;color:var(--text-muted);cursor:pointer;" onclick="document.getElementById('sv-sftp-pw').textContent=document.getElementById('sv-sftp-pw').textContent==='••••••••'?'(mot de passe OmenServer)':'••••••••'">👁️</span>
                            </div>
                        </div>
                    </div>

                    <!-- Boutons d'action -->
                    <div style="display:flex;gap:8px;margin-top:16px;">
                        <a href="sftp://${user}@${ip}:2222/" class="btn btn-primary btn-sm" style="text-decoration:none;display:flex;align-items:center;gap:6px;">
                            <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white' width='16' height='16'%3E%3Cpath d='M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'/%3E%3C/svg%3E" width="14" height="14" />
                            Se connecter avec WinSCP
                        </a>
                        <button class="btn btn-secondary btn-sm" onclick="SvAccess._copyAll()" style="display:flex;align-items:center;gap:6px;">
                            📋 Copier les identifiants
                        </button>
                    </div>

                    <p style="color:var(--text-muted);font-size:11px;margin-top:12px;">
                        💡 <strong>WinSCP</strong> : Cliquez sur "Se connecter" pour ouvrir directement WinSCP avec les bons paramètres.<br>
                        ⚠️ Le service SFTP doit être configuré sur le serveur hôte (port 2222).
                    </p>
                </div>
            </div>
        </div>`;
    },

    _showAddPort() {
        document.getElementById('sv-acc-add-form').style.display = 'block';
    },

    async _addPort() {
        const hostPort = parseInt(document.getElementById('sv-acc-host-port').value);
        const contPort = parseInt(document.getElementById('sv-acc-cont-port').value);
        const proto = document.getElementById('sv-acc-proto').value;
        const msg = document.getElementById('sv-acc-msg');

        if (!hostPort || !contPort) {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = 'Remplissez les deux ports'; }
            return;
        }
        if (hostPort < 1024 || hostPort > 65535) {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = 'Port hôte : 1024-65535'; }
            return;
        }

        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Redémarrage du conteneur...'; }

        const r = await Auth.apiCall(`/api/servers/${this._serverId}/ports`, {
            method: 'POST',
            body: JSON.stringify({host_port: hostPort, container_port: contPort, protocol: proto})
        });

        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Port ajouté !'; }
            document.getElementById('sv-acc-add-form').style.display = 'none';
            this._loadPorts();
        } else {
            const err = r ? await r.json() : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async _removePort(hostPort) {
        if (!confirm(`Supprimer le port ${hostPort} ? Le conteneur sera brièvement redémarré.`)) return;
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/ports/${hostPort}`, {method: 'DELETE'});
        if (r && r.ok) this._loadPorts();
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
            el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Aucun port exposé</div>';
            return;
        }

        el.innerHTML = ports.map(p => {
            const isMain = p.is_main || p.host_port === data.main_port;
            const deleteBtn = isMain ? '' :
                `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();SvAccess._removePort(${p.host_port})" title="Supprimer ce port">🗑️</button>`;
            return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;${isMain ? 'border-left:3px solid var(--accent-green);' : 'border-left:3px solid var(--accent-blue);'}">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-family:monospace;font-weight:600;font-size:14px;">${serverIp} : ${p.host_port}</span>
                    ${isMain ? '<span style="font-size:10px;padding:2px 6px;background:var(--accent-green);color:#000;border-radius:4px;">Principal</span>' : '<span style="font-size:10px;padding:2px 6px;background:var(--accent-blue);color:#fff;border-radius:4px;">Publique</span>'}
                    <span style="font-size:11px;color:var(--text-muted);">${p.protocol.toUpperCase()}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:12px;color:var(--text-muted);">${p.description || ''}</span>
                    ${deleteBtn}
                </div>
            </div>`;
        }).join('');
    },

    _copyAll() {
        const ip = GameServer._serverIP || 'localhost';
        const text = `Protocole: SFTP\nHôte: ${ip}\nPort: 2222\nUtilisateur: server_${this._serverId}\nMot de passe: [ton mot de passe OmenServer]`;
        navigator.clipboard.writeText(text);
    },
};
