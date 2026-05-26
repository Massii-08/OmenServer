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
        <h2>${Lang.t('sv.pl.title')}</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.pl.desc')}</p>
        <div id="sv-pl-tabs" style="display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--border);">
            ${this._subTabs()}
        </div>
        <div id="sv-pl-content"><div style="color:var(--text-muted)">⏳ ${Lang.t('common.loading')}</div></div>`;
    },

    _subTabs() {
        const tabs = [
            {id:'ops',icon:'🛡️',label:Lang.t('sv.pl.ops')},
            {id:'whitelist',icon:'📋',label:Lang.t('sv.pl.whitelist')},
            {id:'banned',icon:'🚫',label:Lang.t('sv.pl.banned')},
        ];
        return tabs.map(t => `
            <button onclick="SvPlayers.switchSub('${t.id}')" 
                style="padding:10px 18px;background:${this._currentSub===t.id?'var(--bg-elev-1)':'transparent'};
                color:${this._currentSub===t.id?'var(--info)':'var(--text-muted)'};
                border:none;border-bottom:2px solid ${this._currentSub===t.id?'var(--info)':'transparent'};
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
        el.innerHTML = `<div style="color:var(--text-muted)">⏳ ${Lang.t('common.loading')}</div>`;
        
        const endpoint = this._currentSub === 'ops' ? 'ops' : this._currentSub === 'whitelist' ? 'whitelist' : 'banned';
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/players/${endpoint}`);
        if (!r || !r.ok) { el.innerHTML = `<div style="color:#e74c3c">❌ ${Lang.t('common.error')}</div>`; return; }
        
        const data = await r.json();
        const players = data.players || [];
        
        const labels = {
            ops: {title:Lang.t('sv.pl.ops'), emoji:'🛡️', addLabel:Lang.t('sv.pl.add_op')}, 
            whitelist: {title:Lang.t('sv.pl.whitelist'), emoji:'📋', addLabel:Lang.t('sv.pl.add_wl')},
            banned: {title:Lang.t('sv.pl.banned'), emoji:'🚫', addLabel:Lang.t('sv.pl.add_ban')}
        };
        const l = labels[this._currentSub];
        
        // Formulaire d'ajout
        let addForm = `
        <div style="background:var(--bg-elev-1);padding:14px;border-radius:8px;margin-bottom:16px;">
            <div style="display:flex;gap:8px;align-items:flex-end;">
                <div style="flex:1;">
                    <label style="font-size:12px;color:var(--text-muted);">${Lang.t('sv.pl.pseudo')}</label>
                    <input type="text" id="sv-pl-name" class="form-input" placeholder="${Lang.t('sv.pl.pseudo_placeholder')}" style="margin-top:4px;" 
                        onkeydown="if(event.key==='Enter')SvPlayers._add()" />
                </div>`;
        if (this._currentSub === 'banned') {
            addForm += `<div style="flex:1;">
                    <label style="font-size:12px;color:var(--text-muted);">${Lang.t('sv.pl.reason')}</label>
                    <input type="text" id="sv-pl-reason" class="form-input" placeholder="${Lang.t('sv.pl.reason_placeholder')}" style="margin-top:4px;" />
                </div>`;
        }
        addForm += `<button class="btn btn-primary" onclick="SvPlayers._add()">➕ ${l.addLabel}</button>
            </div>
            <div id="sv-pl-msg" style="font-size:13px;margin-top:8px;"></div>
        </div>`;
        
        // Liste des joueurs
        let list = '';
        if (players.length === 0) {
            list = `<div style="text-align:center;padding:30px;color:var(--text-muted);">${Lang.t('sv.pl.empty')}</div>`;
        } else {
            list = players.map(p => {
                const name = p.name || Lang.t('sv.pl.unknown');
                const extra = this._currentSub === 'banned' ? ` · <span style="color:var(--text-muted);font-size:11px;">${p.reason||Lang.t('sv.pl.no_reason')}</span>` : '';
                const level = this._currentSub === 'ops' ? ` · <span style="color:var(--info);font-size:11px;">${Lang.t('sv.pl.level')} ${p.level||4}</span>` : '';
                return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-elev-1);border-radius:8px;margin-bottom:6px;">
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
            if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = `✅ ${name} ${Lang.t('sv.pl.added')}`; }
            if (nameEl) nameEl.value = '';
            this._load();
        } else {
            const err = r ? await r.json() : {};
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = `❌ ${err.detail || Lang.t('common.error')}`; }
        }
    },

    async _remove(name) {
        const endpoint = this._currentSub === 'ops' ? 'ops' : this._currentSub === 'whitelist' ? 'whitelist' : 'banned';
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/players/${endpoint}/${encodeURIComponent(name)}`, {method:'DELETE'});
        if (r && r.ok) this._load();
    },
};
