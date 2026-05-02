/**
 * SvSettings — Onglet Paramètres avec 5 sous-onglets style Minestrator.
 * Sous-onglets : Serveur · Map · Protocoles · Pack de ressources · Hébergement
 */
const SvSettings = {
    _serverId: null,
    _serverData: null,
    _props: {},
    _currentSub: 'server',

    render(serverData, serverId) {
        this._serverId = serverId;
        this._serverData = serverData;
        this._currentSub = 'server';
        setTimeout(() => this._loadProperties(), 50);
        return `
        <h2>⚙️ Paramètres</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Configurez les paramètres et options de votre serveur</p>
        <div id="sv-set-tabs" style="display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--border-color);">
            ${this._subTabs()}
        </div>
        <div id="sv-set-content"><div style="color:var(--text-muted)">⏳ Chargement des propriétés...</div></div>`;
    },

    _subTabs() {
        const tabs = [
            {id:'server',icon:'🖥',label:'Serveur'},
            {id:'map',icon:'🗺️',label:'Map'},
            {id:'protocols',icon:'📡',label:'Protocoles'},
            {id:'resourcepack',icon:'🎨',label:'Pack de ressources'},
            {id:'hosting',icon:'🏠',label:'Hébergement'},
        ];
        return tabs.map(t => `
            <button onclick="SvSettings.switchSub('${t.id}')" id="sv-set-tab-${t.id}"
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
        document.getElementById('sv-set-tabs').innerHTML = this._subTabs();
        document.getElementById('sv-set-content').innerHTML = this._subContent();
    },

    _subContent() {
        const p = this._props;
        switch(this._currentSub) {
            case 'server': return this._serverSub(p);
            case 'map': return this._mapSub(p);
            case 'protocols': return this._protocolsSub(p);
            case 'resourcepack': return this._resourcePackSub(p);
            case 'hosting': return this._hostingSub(p);
            default: return '';
        }
    },

    async _loadProperties() {
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/properties`);
        if (r && r.ok) {
            const data = await r.json();
            this._props = data.properties || {};
        }
        const el = document.getElementById('sv-set-content');
        if (el) el.innerHTML = this._subContent();
    },

    _field(label, key, type='text', opts={}) {
        const val = this._props[key] || opts.default || '';
        if (type === 'select' && opts.options) {
            const options = opts.options.map(o => {
                const selected = String(val) === String(o.value) ? 'selected' : '';
                return `<option value="${o.value}" ${selected}>${o.label}</option>`;
            }).join('');
            return `<div style="margin-bottom:16px;">
                <label class="form-label">${label}</label>
                <select class="form-input" data-prop="${key}">${options}</select>
            </div>`;
        }
        if (type === 'toggle') {
            const checked = val === 'true' ? 'checked' : '';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-color);">
                <span style="font-size:13px;">${label}</span>
                <label style="position:relative;width:44px;height:24px;cursor:pointer;">
                    <input type="checkbox" data-prop="${key}" ${checked} style="opacity:0;width:0;height:0;" onchange="this.parentElement.querySelector('span').style.transform=this.checked?'translateX(20px)':'translateX(0)'">
                    <span style="position:absolute;top:0;left:0;right:0;bottom:0;background:${checked?'var(--accent-blue)':'var(--border-color)'};border-radius:12px;transition:.2s;"></span>
                    <span style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:white;border-radius:50%;transition:.2s;transform:${checked?'translateX(20px)':'translateX(0)'}"></span>
                </label>
            </div>`;
        }
        return `<div style="margin-bottom:16px;">
            <label class="form-label">${label}</label>
            <input type="${type}" class="form-input" data-prop="${key}" value="${val}" placeholder="${opts.placeholder||''}" />
        </div>`;
    },

    _saveBtn() {
        return `<div style="margin-top:20px;display:flex;align-items:center;gap:12px;">
            <button class="btn btn-primary" onclick="SvSettings._save()">💾 Sauvegarder</button>
            <span id="sv-set-msg" style="font-size:13px;"></span>
            <span style="font-size:12px;color:var(--text-muted);">⚠️ Un redémarrage peut être nécessaire</span>
        </div>`;
    },

    async _save() {
        const inputs = document.querySelectorAll('[data-prop]');
        const props = {};
        inputs.forEach(el => {
            const key = el.dataset.prop;
            if (el.type === 'checkbox') props[key] = el.checked ? 'true' : 'false';
            else props[key] = el.value;
        });
        const msg = document.getElementById('sv-set-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳ Sauvegarde...'; }
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/properties`, {
            method: 'PUT', body: JSON.stringify({properties: props})
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Sauvegardé !'; }
            this._props = {...this._props, ...props};
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    // --- Sous-onglet Serveur ---
    _serverSub(p) {
        return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div>${this._field('MOTD (Message du jour)', 'motd', 'text', {default:'A Minecraft Server'})}</div>
            <div>${this._field('Nombre max de joueurs', 'max-players', 'number', {default:'20'})}</div>
        </div>
        ${this._field('Difficulté', 'difficulty', 'select', {options:[
            {value:'peaceful',label:'☮️ Peaceful'},{value:'easy',label:'😊 Easy'},
            {value:'normal',label:'⚔️ Normal'},{value:'hard',label:'💀 Hard'}
        ]})}
        ${this._field('Mode de jeu', 'gamemode', 'select', {options:[
            {value:'survival',label:'⛏️ Survie'},{value:'creative',label:'🎨 Créatif'},
            {value:'adventure',label:'🗺️ Aventure'},{value:'spectator',label:'👁️ Spectateur'}
        ]})}
        ${this._field('PvP activé', 'pvp', 'toggle')}
        ${this._field('Mode Hardcore', 'hardcore', 'toggle')}
        ${this._field('Mode en ligne (vérification Mojang)', 'online-mode', 'toggle')}
        ${this._field('Apparition des animaux', 'spawn-animals', 'toggle')}
        ${this._field('Apparition des monstres', 'spawn-monsters', 'toggle')}
        ${this._field('Apparition des PNJ', 'spawn-npcs', 'toggle')}
        ${this._field('Autoriser le vol', 'allow-flight', 'toggle')}
        ${this._field('Autoriser le Nether', 'allow-nether', 'toggle')}
        ${this._field('Blocs de commande', 'enable-command-block', 'toggle')}
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Map ---
    _mapSub(p) {
        return `
        ${this._field('Nom du monde', 'level-name', 'text', {default:'world'})}
        ${this._field('Seed', 'level-seed', 'text', {placeholder:'Laisser vide pour aléatoire'})}
        ${this._field('Type de monde', 'level-type', 'select', {options:[
            {value:'minecraft:normal',label:'🌍 Normal'},{value:'minecraft:flat',label:'🟩 Plat (Flat)'},
            {value:'minecraft:large_biomes',label:'🏔️ Grands biomes'},{value:'minecraft:amplified',label:'⛰️ Amplifié'}
        ]})}
        ${this._field('Protection du spawn (rayon en blocs)', 'spawn-protection', 'number', {default:'16'})}
        ${this._field('Distance de vue (chunks)', 'view-distance', 'number', {default:'10'})}
        ${this._field('Distance de simulation (chunks)', 'simulation-distance', 'number', {default:'10'})}
        ${this._field('Taille max du monde (blocs)', 'max-world-size', 'number', {default:'29999984'})}
        ${this._field('Générer les structures', 'generate-structures', 'toggle')}
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Protocoles ---
    _protocolsSub(p) {
        return `
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;margin-bottom:20px;">
            <h3 style="margin:0 0 8px;font-size:15px;">📡 RCON (Remote Console)</h3>
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">Permet de contrôler le serveur à distance via des commandes.</p>
            ${this._field('Activer RCON', 'enable-rcon', 'toggle')}
            ${this._field('Port RCON', 'rcon.port', 'number', {default:'25575'})}
            ${this._field('Mot de passe RCON', 'rcon.password', 'text', {placeholder:'Mot de passe RCON'})}
        </div>
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
            <h3 style="margin:0 0 8px;font-size:15px;">🔍 Query</h3>
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">Permet aux services tiers de lister votre serveur.</p>
            ${this._field('Activer Query', 'enable-query', 'toggle')}
            ${this._field('Port Query', 'query.port', 'number', {default:'25565'})}
        </div>
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Pack de ressources ---
    _resourcePackSub(p) {
        return `
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;margin-bottom:16px;">
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px;">
                Entrez l'URL d'un pack de ressources pour que les joueurs le téléchargent automatiquement en rejoignant.
            </p>
            ${this._field('URL du pack de ressources', 'resource-pack', 'text', {placeholder:'https://example.com/pack.zip'})}
            ${this._field('SHA-1 du pack (vérification)', 'resource-pack-sha1', 'text', {placeholder:'Hash SHA-1 optionnel'})}
            ${this._field('Texte affiché au joueur', 'resource-pack-prompt', 'text', {placeholder:'Ce serveur utilise un pack de ressources personnalisé'})}
            ${this._field('Pack de ressources obligatoire', 'require-resource-pack', 'toggle')}
        </div>
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Hébergement ---
    _hostingSub(p) {
        const s = this._serverData;
        return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">Type de serveur</div>
                <div style="font-size:15px;margin-top:4px;font-weight:600;">${s.game_type || 'minecraft'}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">Version</div>
                <div style="font-size:15px;margin-top:4px;font-weight:600;">${s.version || 'LATEST'}</div>
            </div>
        </div>
        <h3 style="font-size:15px;margin-bottom:12px;">📊 Ressources</h3>
        <div style="margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <label class="form-label" style="margin:0;">💻 Mémoire RAM</label>
                <span id="sv-ram-val" style="font-family:monospace;font-weight:700;color:var(--accent-blue);font-size:16px;">${s.memory_mb||1024} Mo</span>
            </div>
            <input type="range" id="sv-ram-slider" min="256" max="8192" step="256" value="${s.memory_mb||1024}"
                style="width:100%;accent-color:var(--accent-blue);cursor:pointer;"
                oninput="document.getElementById('sv-ram-val').textContent=this.value+' Mo'" />
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:4px;">
                <span>256 Mo</span><span>8192 Mo (8 Go)</span>
            </div>
        </div>
        <div style="margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <label class="form-label" style="margin:0;">⚡ CPU</label>
                <span id="sv-cpu-val" style="font-family:monospace;font-weight:700;color:var(--accent-orange);font-size:16px;">${s.cpu_percent||100}%</span>
            </div>
            <input type="range" id="sv-cpu-slider" min="25" max="400" step="25" value="${s.cpu_percent||100}"
                style="width:100%;accent-color:var(--accent-orange);cursor:pointer;"
                oninput="document.getElementById('sv-cpu-val').textContent=this.value+'%'" />
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:4px;">
                <span>25% (¼ cœur)</span><span>400% (4 cœurs)</span>
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
            <button class="btn btn-primary" onclick="SvSettings._saveResources()">💾 Appliquer les ressources</button>
            <span id="sv-res-msg" style="font-size:13px;"></span>
        </div>`;
    },

    async _saveResources() {
        const ram = parseInt(document.getElementById('sv-ram-slider').value);
        const cpu = parseInt(document.getElementById('sv-cpu-slider').value);
        const msg = document.getElementById('sv-res-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = '⏳...'; }
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/resources`, {
            method: 'PUT', body: JSON.stringify({memory_mb: ram, cpu_percent: cpu})
        });
        if (r && r.ok) {
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = '✅ Appliqué !'; }
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },
};
