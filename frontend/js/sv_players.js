/**
 * SvPlayers — Onglet Joueurs avec 3 sous-onglets style Minestrator.
 * Sous-onglets : Opérateurs · Liste blanche · Bannis
 */
const SvPlayers = {
    _serverId: null,
    _currentSub: 'ops',

    render(serverId) {
        this._serverId = serverId;
        this._currentSub = 'ops';
        setTimeout(() => this._load(), 50);
        return `
        <h2>👥 Joueurs</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Gérez les opérateurs, la whitelist et les joueurs bannis</p>
        <div id="sv-pl-tabs" style="display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--border-color);">
            ${this._subTabs()}
        </div>
        <div id="sv-pl-content"><div style="color:var(--text-muted)">⏳ Chargement...</div></div>`;
    },

    _subTabs() {
        const tabs = [
            {id:'ops',icon:'🛡️',label:'Opérateurs'},
            {id:'whitelist',icon:'📋',label:'Liste blanche'},
            {id:'banned',icon:'🚫',label:'Bannis'},
        ];
        return tabs.map(t => `
            <button onclick="SvPlayers.switchSub('${t.id}')" 
                style="padding:10px 18px;background:${this._currentSub===t.id?'var(--bg-card)':'transparent'};
                color:${this._currentSub===t.id?'var(--accent-blue)':'var(--text-muted)'};
                border:none;border-bottom:2px solid ${this._currentSub===t.id?'var(--accent-blue)':'transparent'};
                cursor:pointer;font-size:13px;font-weight:${this._currentSub===t.id?'600':'400'};
                transition:all .15s;margin-bottom:-2px;">
                ${t.icon} ${t.label}
            </button>`).join('');
    },

    switchSub(sub) {
        this._currentSub = sub;
        document.getElementById('sv-pl-tabs').innerHTML = this._subTabs();
        this._load();
    },

    async _load() {
        const el = document.getElementById('sv-pl-content');
        if (!el) return;
        el.innerHTML = '<div style="color:var(--text-muted)">⏳ Chargement...</div>';
        
        const endpoint = this._currentSub === 'ops' ? 'ops' : this._currentSub === 'whitelist' ? 'whitelist' : 'banned';
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/players/${endpoint}`);
        if (!r || !r.ok) { el.innerHTML = '<div style="color:#e74c3c">❌ Erreur de chargement</div>'; return; }
        
        const data = await r.json();
        const players = data.players || [];
        
        const labels = {ops: {title:'Opérateurs', emoji:'🛡️', addLabel:'Ajouter un opérateur'}, 
            whitelist: {title:'Liste blanche', emoji:'📋', addLabel:'Ajouter à la whitelist'},
            banned: {title:'Bannis', emoji:'🚫', addLabel:'Bannir un joueur'}};
        const l = labels[this._currentSub];
        
        // Formulaire d'ajout
        let addForm = `
        <div style="background:var(--bg-secondary);padding:14px;border-radius:8px;margin-bottom:16px;">
            <div style="display:flex;gap:8px;align-items:flex-end;">
                <div style="flex:1;">
                    <label style="font-size:12px;color:var(--text-muted);">Pseudo Minecraft</label>
                    <input type="text" id="sv-pl-name" class="form-input" placeholder="Pseudo du joueur" style="margin-top:4px;" 
                        onkeydown="if(event.key==='Enter')SvPlayers._add()" />
                </div>`;
        if (this._currentSub === 'banned') {
            addForm += `<div style="flex:1;">
                    <label style="font-size:12px;color:var(--text-muted);">Raison</label>
                    <input type="text" id="sv-pl-reason" class="form-input" placeholder="Raison du ban" style="margin-top:4px;" />
                </div>`;
        }
        addForm += `<button class="btn btn-primary" onclick="SvPlayers._add()">➕ ${l.addLabel}</button>
            </div>
            <div id="sv-pl-msg" style="font-size:13px;margin-top:8px;"></div>
        </div>`;
        
        // Liste des joueurs
        let list = '';
        if (players.length === 0) {
            list = `<div style="text-align:center;padding:30px;color:var(--text-muted);">Aucun joueur dans cette liste</div>`;
        } else {
            list = players.map(p => {
                const name = p.name || 'Inconnu';
                const extra = this._currentSub === 'banned' ? ` · <span style="color:var(--text-muted);font-size:11px;">${p.reason||'Aucune raison'}</span>` : '';
                const level = this._currentSub === 'ops' ? ` · <span style="color:var(--accent-blue);font-size:11px;">Niveau ${p.level||4}</span>` : '';
                return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;">
                    <div>
                        <span style="font-weight:600;font-size:14px;">${l.emoji} ${name}</span>${level}${extra}
                    </div>
                    <button class="btn btn-sm btn-danger" onclick="SvPlayers._remove('${name}')">🗑️</button>
                </div>`;
            }).join('');
        }
        
        el.innerHTML = addForm + list;
    },

    async _add() {
        const nameEl = document.getElementById('sv-pl-name');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) return;
        
        const msg = document.getElementById('sv-pl-msg');
        const endpoint = this._currentSub === 'ops' ? 'ops' : this._currentSub === 'whitelist' ? 'whitelist' : 'banned';
        
        let body = {name};
        if (this._currentSub === 'banned') {
            const reasonEl = document.getElementById('sv-pl-reason');
            body.reason = reasonEl ? reasonEl.value.trim() || 'Banned by OmenServer' : 'Banned by OmenServer';
        }
        
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/players/${endpoint}`, {
            method: 'POST', body: JSON.stringify(body)
        });
        
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = `✅ ${name} ajouté !`; }
            if (nameEl) nameEl.value = '';
            this._load();
        } else {
            const err = r ? await r.json() : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || 'Erreur'}`; }
        }
    },

    async _remove(name) {
        const endpoint = this._currentSub === 'ops' ? 'ops' : this._currentSub === 'whitelist' ? 'whitelist' : 'banned';
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/players/${endpoint}/${encodeURIComponent(name)}`, {method:'DELETE'});
        if (r && r.ok) this._load();
    },
};
