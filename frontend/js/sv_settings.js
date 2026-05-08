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
        <h2>${Lang.t('sv.set_title')}</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">${Lang.t('sv.set_desc')}</p>
        <div id="sv-set-tabs" style="display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--border-color);">
            ${this._subTabs()}
        </div>
        <div id="sv-set-content"><div style="color:var(--text-muted)">${Lang.t('sv.set_loading')}</div></div>`;
    },

    _subTabs() {
        const tabs = [
            {id:'server',icon:'🖥',label:Lang.t('sv.set_server')},
            {id:'map',icon:'🗺️',label:Lang.t('sv.set_map')},
            {id:'protocols',icon:'📡',label:Lang.t('sv.set_protocols')},
            {id:'resourcepack',icon:'🎨',label:Lang.t('sv.set_resourcepack')},
            {id:'jvm',icon:'☕',label:Lang.t('sv.set_jvm')},
            {id:'hosting',icon:'🏠',label:Lang.t('sv.set_hosting')},
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
            case 'jvm': return this._jvmSub(p);
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
            <button class="btn btn-primary" onclick="SvSettings._save()">${Lang.t('sv.set_save')}</button>
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
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = Lang.t('sv.set_saved'); }
            this._props = {...this._props, ...props};
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    // --- Sous-onglet Serveur ---
    _serverSub(p) {
        return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div>${this._field(Lang.t('sv.cfg.motd'), 'motd', 'text', {default:'A Minecraft Server'})}</div>
            <div>${this._field(Lang.t('sv.cfg.max_players'), 'max-players', 'number', {default:'20'})}</div>
        </div>
        ${this._field(Lang.t('sv.cfg.difficulty'), 'difficulty', 'select', {options:[
            {value:'peaceful',label:'☮️ Peaceful'},{value:'easy',label:'😊 Easy'},
            {value:'normal',label:'⚔️ Normal'},{value:'hard',label:'💀 Hard'}
        ]})}
        ${this._field(Lang.t('sv.cfg.gamemode'), 'gamemode', 'select', {options:[
            {value:'survival',label:Lang.t('sv.cfg.survival')},{value:'creative',label:Lang.t('sv.cfg.creative')},
            {value:'adventure',label:Lang.t('sv.cfg.adventure')},{value:'spectator',label:Lang.t('sv.cfg.spectator')}
        ]})}
        ${this._field(Lang.t('sv.cfg.pvp'), 'pvp', 'toggle')}
        ${this._field(Lang.t('sv.cfg.hardcore'), 'hardcore', 'toggle')}
        ${this._field(Lang.t('sv.cfg.online_mode'), 'online-mode', 'toggle')}
        ${this._field(Lang.t('sv.cfg.spawn_animals'), 'spawn-animals', 'toggle')}
        ${this._field(Lang.t('sv.cfg.spawn_monsters'), 'spawn-monsters', 'toggle')}
        ${this._field(Lang.t('sv.cfg.spawn_npcs'), 'spawn-npcs', 'toggle')}
        ${this._field(Lang.t('sv.cfg.allow_flight'), 'allow-flight', 'toggle')}
        ${this._field(Lang.t('sv.cfg.allow_nether'), 'allow-nether', 'toggle')}
        ${this._field(Lang.t('sv.cfg.command_blocks'), 'enable-command-block', 'toggle')}
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Map ---
    _mapSub(p) {
        return `
        ${this._field(Lang.t('sv.cfg.world_name'), 'level-name', 'text', {default:'world'})}
        ${this._field(Lang.t('sv.cfg.seed'), 'level-seed', 'text', {placeholder:Lang.t('sv.cfg.seed_hint')})}
        ${this._field(Lang.t('sv.cfg.world_type'), 'level-type', 'select', {options:[
            {value:'minecraft:normal',label:'🌍 Normal'},{value:'minecraft:flat',label:Lang.t('sv.cfg.flat')},
            {value:'minecraft:large_biomes',label:Lang.t('sv.cfg.large_biomes')},{value:'minecraft:amplified',label:Lang.t('sv.cfg.amplified')}
        ]})}
        ${this._field(Lang.t('sv.cfg.spawn_protection'), 'spawn-protection', 'number', {default:'16'})}
        ${this._field(Lang.t('sv.cfg.view_distance'), 'view-distance', 'number', {default:'10'})}
        ${this._field(Lang.t('sv.cfg.sim_distance'), 'simulation-distance', 'number', {default:'10'})}
        ${this._field(Lang.t('sv.cfg.max_world'), 'max-world-size', 'number', {default:'29999984'})}
        ${this._field(Lang.t('sv.cfg.gen_structures'), 'generate-structures', 'toggle')}
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Protocoles ---
    _protocolsSub(p) {
        return `
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;margin-bottom:20px;">
            <h3 style="margin:0 0 8px;font-size:15px;">📡 RCON (Remote Console)</h3>
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">${Lang.t('sv.cfg.rcon_desc')}</p>
            ${this._field(Lang.t('sv.cfg.enable_rcon'), 'enable-rcon', 'toggle')}
            ${this._field(Lang.t('sv.cfg.rcon_port'), 'rcon.port', 'number', {default:'25575'})}
            ${this._field(Lang.t('sv.cfg.rcon_pass'), 'rcon.password', 'text', {placeholder:Lang.t('sv.cfg.rcon_pass')})}
        </div>
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
            <h3 style="margin:0 0 8px;font-size:15px;">🔍 Query</h3>
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">${Lang.t('sv.cfg.query_desc')}</p>
            ${this._field(Lang.t('sv.cfg.enable_query'), 'enable-query', 'toggle')}
            ${this._field(Lang.t('sv.cfg.query_port'), 'query.port', 'number', {default:'25565'})}
        </div>
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Pack de ressources ---
    _resourcePackSub(p) {
        return `
        <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;margin-bottom:16px;">
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px;">
                ${Lang.t('sv.cfg.rp_desc')}
            </p>
            ${this._field(Lang.t('sv.cfg.rp_url'), 'resource-pack', 'text', {placeholder:'https://example.com/pack.zip'})}
            ${this._field(Lang.t('sv.cfg.rp_sha1'), 'resource-pack-sha1', 'text', {placeholder:'Hash SHA-1'})}
            ${this._field(Lang.t('sv.cfg.rp_prompt'), 'resource-pack-prompt', 'text', {placeholder:''})}
            ${this._field(Lang.t('sv.cfg.rp_required'), 'require-resource-pack', 'toggle')}
        </div>
        ${this._saveBtn()}`;
    },

    // --- Sous-onglet Hébergement ---
    _hostingSub(p) {
        const s = this._serverData;
        return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">${Lang.t('sv.cfg.server_type')}</div>
                <div style="font-size:15px;margin-top:4px;font-weight:600;">${s.game_type || 'minecraft'}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:16px;border-radius:10px;">
                <div style="font-size:12px;color:var(--text-muted);">Version</div>
                <div style="font-size:15px;margin-top:4px;font-weight:600;">${s.version || 'LATEST'}</div>
            </div>
        </div>
        <h3 style="font-size:15px;margin-bottom:12px;">${Lang.t('sv.cfg.resources')}</h3>
        <div style="margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <label class="form-label" style="margin:0;">${Lang.t('sv.cfg.memory')}</label>
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
                <span>25% (¼ core)</span><span>400% (4 cores)</span>
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
            <button class="btn btn-primary" onclick="SvSettings._saveResources()">${Lang.t('sv.cfg.apply_resources')}</button>
            <span id="sv-res-msg" style="font-size:13px;"></span>
        </div>

        <!-- Zone dangereuse -->
        <div style="margin-top:32px;padding:20px;border-radius:10px;border:1px solid rgba(239,68,68,0.3);background:rgba(239,68,68,0.05);">
            <h3 style="margin:0 0 8px;font-size:15px;color:#ef4444;">${Lang.t('sv.cfg.danger_zone')}</h3>
            <p style="color:var(--text-muted);font-size:12px;margin-bottom:16px;">
                ${Lang.t('sv.cfg.danger_desc')}
            </p>
            <div id="sv-del-zone">
                <button class="btn" style="background:#ef4444;color:white;" onclick="SvSettings._showDeleteConfirm()">
                    🗑️ Supprimer ce serveur
                </button>
            </div>
            <div id="sv-del-confirm" style="display:none;margin-top:12px;padding:14px;background:rgba(239,68,68,0.1);border-radius:8px;border:1px solid #ef4444;">
                <p style="font-size:13px;color:#ef4444;margin-bottom:10px;">
                    Tape <strong>${s.name}</strong> pour confirmer la suppression :
                </p>
                <div style="display:flex;gap:8px;align-items:center;">
                    <input id="sv-del-input" class="form-input" placeholder="${s.name}" style="flex:1;border-color:#ef4444;" />
                    <button class="btn" style="background:#ef4444;color:white;" onclick="SvSettings._confirmDelete('${s.name.replace(/'/g, "\\'")}')">
                        ${Lang.t('sv.cfg.delete_btn')}
                    </button>
                    <button class="btn btn-secondary" onclick="document.getElementById('sv-del-confirm').style.display='none'">
                        ${Lang.t('common.cancel')}
                    </button>
                </div>
                <div id="sv-del-msg" style="font-size:13px;margin-top:8px;"></div>
            </div>
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
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = Lang.t('sv.cfg.res_applied'); }
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    // --- Sous-onglet JVM / Java ---
    _jvmSub(p) {
        const s = this._serverData;
        const currentFlags = s.jvm_flags || '';

        const presets = [
            {
                id: 'aikar',
                name: Lang.t('sv.cfg.jvm_aikar'),
                desc: Lang.t('sv.cfg.jvm_aikar_desc'),
                flags: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1'
            },
            {
                id: 'performance',
                name: Lang.t('sv.cfg.jvm_perf'),
                desc: Lang.t('sv.cfg.jvm_perf_desc'),
                flags: '-XX:+UseG1GC -XX:+OptimizeStringConcat -XX:+UseCompressedOops'
            },
            {
                id: 'lowram',
                name: Lang.t('sv.cfg.jvm_lowram'),
                desc: Lang.t('sv.cfg.jvm_lowram_desc'),
                flags: '-XX:+UseSerialGC -XX:+OptimizeStringConcat'
            },
            {
                id: 'none',
                name: Lang.t('sv.cfg.jvm_none'),
                desc: Lang.t('sv.cfg.jvm_none_desc'),
                flags: ''
            },
        ];

        return `
        <div style="background:linear-gradient(135deg, rgba(249,115,22,0.1), rgba(234,88,12,0.05));padding:16px;border-radius:10px;margin-bottom:20px;border:1px solid rgba(249,115,22,0.2);">
            <div style="font-size:13px;color:var(--text-muted);">${Lang.t('sv.cfg.jvm_info')}</div>
        </div>

        <div style="font-weight:600;margin-bottom:12px;">${Lang.t('sv.cfg.jvm_presets')}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;">
            ${presets.map(pr => `
                <div style="background:var(--bg-secondary);padding:12px;border-radius:8px;cursor:pointer;border:2px solid var(--border-color);transition:all .15s;"
                    onclick="document.getElementById('sv-jvm-textarea').value='${pr.flags.replace(/'/g, "\\\'")}';"                    onmouseover="this.style.borderColor='var(--accent-blue)'"
                    onmouseout="this.style.borderColor='var(--border-color)'">
                    <div style="font-size:13px;font-weight:600;">${pr.name}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${pr.desc}</div>
                </div>
            `).join('')}
        </div>

        <div style="font-weight:600;margin-bottom:8px;">${Lang.t('sv.cfg.jvm_custom')}</div>
        <textarea id="sv-jvm-textarea" class="form-input" rows="5" style="font-family:monospace;font-size:12px;resize:vertical;">${currentFlags}</textarea>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${Lang.t('sv.cfg.jvm_hint')}</div>

        <div style="margin-top:16px;display:flex;align-items:center;gap:12px;">
            <button class="btn btn-primary" onclick="SvSettings._saveJvm()">${Lang.t('sv.cfg.jvm_save')}</button>
            <span id="sv-jvm-msg" style="font-size:13px;"></span>
        </div>`;
    },

    async _saveJvm() {
        const flags = document.getElementById('sv-jvm-textarea')?.value?.trim() || '';
        const msg = document.getElementById('sv-jvm-msg');
        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = Lang.t('sv.cfg.jvm_saving'); }
        const r = await Auth.apiCall(`/api/servers/${this._serverId}/jvm-flags`, {
            method: 'PUT', body: JSON.stringify({ jvm_flags: flags })
        });
        if (r && r.ok) {
            const data = await r.json();
            if (msg) { msg.style.color = 'var(--accent-green)'; msg.textContent = `✅ ${data.message} ${data.note}`; }
            this._serverData.jvm_flags = flags;
        } else {
            if (msg) { msg.style.color = '#e74c3c'; msg.textContent = '❌ Erreur'; }
        }
    },

    // --- Suppression du serveur ---

    _showDeleteConfirm() {
        document.getElementById('sv-del-confirm').style.display = 'block';
        document.getElementById('sv-del-input').value = '';
        document.getElementById('sv-del-input').focus();
    },

    async _confirmDelete(serverName) {
        const input = document.getElementById('sv-del-input')?.value?.trim();
        const msg = document.getElementById('sv-del-msg');

        if (input !== serverName) {
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = Lang.t('sv.cfg.delete_name_mismatch'); }
            return;
        }

        if (msg) { msg.style.color = 'var(--accent-blue)'; msg.textContent = Lang.t('sv.cfg.deleting'); }

        const r = await Auth.apiCall(`/api/servers/${this._serverId}`, { method: 'DELETE' });
        if (r && r.ok) {
            if (typeof Toast !== 'undefined') Toast.success(`🗑️ Serveur '${serverName}' supprimé`);
            App.navigateTo('game_server');
        } else {
            const err = r ? await r.json().catch(() => ({})) : {};
            if (msg) { msg.style.color = '#ef4444'; msg.textContent = `❌ ${err.detail || Lang.t('common.error')}`; }
        }
    },
};
