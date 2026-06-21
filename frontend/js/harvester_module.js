// frontend/js/harvester_module.js
// Vue dédiée AI Harvester (P1) : formulaire de lancement + progression live +
// clé API privée. Admin-only (le backend garde aussi la porte).
const HarvesterModule = {
    _container: null,
    _jobId: null,
    _feedKey: null,
    _pollInterval: null,

    _demoRecipe() {
        return JSON.stringify({
            item_selector: { tag: 'article', class: 'product_pod' },
            fields: {
                title: { selector: [{ tag: 'h3' }, { tag: 'a' }], extract: 'attr:title' },
                price: { selector: { tag: 'p', class: 'price_color' }, extract: 'text' },
                availability: { selector: { tag: 'p', class: 'availability' }, extract: 'text' },
                rating: { selector: { tag: 'p', class: 'star-rating' }, extract: 'class:1' },
            },
        }, null, 2);
    },

    _demoPlan() {
        return JSON.stringify({ mode: 'pagination', next_selector: { tag: 'li', class: 'next' } }, null, 2);
    },

    async render(container) {
        this._container = container;
        let active = null;
        try {
            const r = await Auth.apiCall('/api/bots/harvester/active');
            if (r && r.ok) active = await r.json();
        } catch (e) { /* ignore */ }
        if (active && active.job_id) {
            this._jobId = active.job_id;
            this._feedKey = active.feed_key || this._feedKey;  // dispo dès le 1er rendu
            this._renderRunning(active);
            this._startPolling();
        } else {
            this._renderForm();
        }
    },

    unload() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    },

    // Les tiers sont mutuellement exclusifs (un seul fetch_tier) : cocher l'un
    // décoche l'autre.
    _exclusiveTier(which) {
        const s = document.getElementById('hrv-stealth');
        const u = document.getElementById('hrv-unblocker');
        if (which === 'stealth' && s && s.checked && u) u.checked = false;
        if (which === 'unblocker' && u && u.checked && s) s.checked = false;
    },

    _tierLabel(tier) {
        if (tier === 'stealth') return Lang.t('harvester.tier_stealth');
        if (tier === 'unblocker') return Lang.t('harvester.tier_unblocker');
        return tier ? Lang.t('harvester.tier_httpx') : '';
    },

    _renderForm() {
        const c = this._container;
        c.innerHTML = `
        <div class="card">
          <div class="b-head" style="margin-bottom:12px;">
            <span class="b-icon b-ticker">HRV</span>
            <div class="b-name-wrap"><div class="b-name">${Lang.t('harvester.title')}</div>
            <div class="b-type">${Lang.t('harvester.subtitle')}</div></div>
          </div>
          <label class="form-label">${Lang.t('harvester.form_url')}</label>
          <input id="hrv-url" class="form-input" value="https://books.toscrape.com/catalogue/page-1.html" />
          <label class="form-label">${Lang.t('harvester.instructions')}</label>
          <textarea id="hrv-instructions" class="form-input" rows="2" placeholder="ex: titre, prix, disponibilité de chaque livre"></textarea>
          <div style="margin:8px 0;display:flex;gap:8px;align-items:center;">
            <button class="btn btn-secondary" id="hrv-gen-btn" onclick="HarvesterModule.generate()">${Lang.t('harvester.generate')}</button>
            <span id="hrv-gen-status" style="font-size:12px;color:var(--text-dim);"></span>
          </div>
          <div id="hrv-preview"></div>
          <label class="form-label">${Lang.t('harvester.form_recipe')}</label>
          <textarea id="hrv-recipe" class="form-input" rows="10" style="font-family:var(--font-mono);">${this._demoRecipe()}</textarea>
          <label class="form-label">${Lang.t('harvester.form_plan')}</label>
          <textarea id="hrv-plan" class="form-input" rows="4" style="font-family:var(--font-mono);">${this._demoPlan()}</textarea>
          <label style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer;font-size:14px;">
            <input type="checkbox" id="hrv-stealth" onchange="HarvesterModule._exclusiveTier('stealth')" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />
            <span>${Lang.t('harvester.stealth')}</span>
          </label>
          <div class="form-hint">${Lang.t('harvester.stealth_hint')}</div>
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;font-size:14px;">
            <input type="checkbox" id="hrv-unblocker" onchange="HarvesterModule._exclusiveTier('unblocker')" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />
            <span>${Lang.t('harvester.unblocker')}</span>
          </label>
          <div class="form-hint">${Lang.t('harvester.unblocker_hint')}</div>
          <details id="hrv-unb-settings" style="margin-top:8px;border:1px solid var(--border);border-radius:var(--r-md);padding:0 12px;">
            <summary style="cursor:pointer;padding:10px 0;font-size:13px;color:var(--text-muted);">${Lang.t('harvester.unblocker_settings')} · <span id="hrv-unb-status" style="color:var(--text-dim);">—</span></summary>
            <div style="padding-bottom:12px;">
              <label class="form-label">${Lang.t('harvester.unblocker_endpoint')}</label>
              <input id="hrv-unb-endpoint" class="form-input" placeholder="https://api.zenrows.com/v1/" />
              <label class="form-label">${Lang.t('harvester.unblocker_key_label')}</label>
              <input id="hrv-unb-key" class="form-input" type="password" autocomplete="off" placeholder="${Lang.t('harvester.unblocker_key_ph')}" />
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
                <div style="flex:1;min-width:110px;"><label class="form-label">${Lang.t('harvester.unblocker_method')}</label>
                  <select id="hrv-unb-method" class="form-input"><option value="POST">POST</option><option value="GET">GET</option></select></div>
                <div style="flex:1;min-width:110px;"><label class="form-label">${Lang.t('harvester.unblocker_keyplace')}</label>
                  <select id="hrv-unb-keyin" class="form-input"><option value="body">body</option><option value="query">query</option><option value="header">header</option></select></div>
                <div style="flex:1;min-width:110px;"><label class="form-label">${Lang.t('harvester.unblocker_keyparam')}</label>
                  <input id="hrv-unb-keyparam" class="form-input" value="apikey" /></div>
              </div>
              <label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;font-size:14px;">
                <input type="checkbox" id="hrv-unb-render" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />
                <span>${Lang.t('harvester.unblocker_render')}</span>
              </label>
              <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button class="btn btn-sm btn-primary" onclick="HarvesterModule.saveUnblockerConfig()">${Lang.t('harvester.unblocker_save')}</button>
                <button class="btn btn-sm btn-ghost" onclick="HarvesterModule.clearUnblockerConfig()">${Lang.t('harvester.unblocker_clear')}</button>
                <span id="hrv-unb-msg" style="font-size:12px;color:var(--text-dim);"></span>
              </div>
            </div>
          </details>
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;font-size:14px;">
            <input type="checkbox" id="hrv-dedupe" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />
            <span>${Lang.t('harvester.dedupe')}</span>
          </label>
          <div class="form-hint">${Lang.t('harvester.dedupe_hint')}</div>
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="HarvesterModule.start()">${Lang.t('harvester.start')}</button>
            <button class="btn btn-ghost" onclick="BotsModule.render(BotsModule._container)">${Lang.t('harvester.back')}</button>
          </div>
        </div>`;
        this._loadUnblockerConfig();   // pré-remplit l'état (clé masquée) du débloqueur
    },

    async _loadUnblockerConfig() {
        try {
            const r = await Auth.apiCall('/api/bots/harvester/unblocker-config');
            if (!r || !r.ok) return;
            const d = await r.json();
            const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
            set('hrv-unb-endpoint', d.endpoint || '');
            set('hrv-unb-method', d.method || 'POST');
            set('hrv-unb-keyin', d.key_in || 'body');
            set('hrv-unb-keyparam', d.key_param || 'apikey');
            const render = document.getElementById('hrv-unb-render');
            if (render) render.checked = !!d.render_js;
            const status = document.getElementById('hrv-unb-status');
            if (status) {
                status.textContent = d.configured
                    ? (Lang.t('harvester.unblocker_configured') + (d.key_masked ? ' · ' + d.key_masked : ''))
                    : Lang.t('harvester.unblocker_notconfigured');
            }
        } catch (e) { /* ignore */ }
    },

    async saveUnblockerConfig() {
        const v = id => ((document.getElementById(id) || {}).value || '');
        const body = {
            endpoint: v('hrv-unb-endpoint').trim(),
            key: v('hrv-unb-key'),                 // vide -> le backend garde l'actuelle
            method: v('hrv-unb-method'),
            key_in: v('hrv-unb-keyin'),
            key_param: v('hrv-unb-keyparam').trim(),
            render_js: !!(document.getElementById('hrv-unb-render') || {}).checked,
        };
        const msg = document.getElementById('hrv-unb-msg');
        const r = await Auth.apiCall('/api/bots/harvester/unblocker-config', {
            method: 'POST', body: JSON.stringify(body),
        });
        if (!r || !r.ok) {
            const d = r ? (await r.json().catch(() => ({}))) : {};
            if (msg) msg.textContent = d.detail || 'Error';
            return;
        }
        const key = document.getElementById('hrv-unb-key');
        if (key) key.value = '';                   // ne jamais garder la clé en clair dans le champ
        if (msg) msg.textContent = Lang.t('harvester.unblocker_saved');
        this._loadUnblockerConfig();
    },

    async clearUnblockerConfig() {
        await Auth.apiCall('/api/bots/harvester/unblocker-config/clear', { method: 'POST' });
        const key = document.getElementById('hrv-unb-key');
        if (key) key.value = '';
        const msg = document.getElementById('hrv-unb-msg');
        if (msg) msg.textContent = '';
        this._loadUnblockerConfig();
    },

    async generate() {
        const url = document.getElementById('hrv-url').value.trim();
        const instructions = document.getElementById('hrv-instructions').value.trim();
        const btn = document.getElementById('hrv-gen-btn');
        const status = document.getElementById('hrv-gen-status');
        if (btn) btn.disabled = true;
        if (status) status.textContent = Lang.t('harvester.generating');
        try {
            const r = await Auth.apiCall('/api/bots/harvester/setup', {
                method: 'POST',
                body: JSON.stringify({ url, instructions }),
            });
            if (!r || !r.ok) {
                const detail = r ? (await r.json().catch(() => ({}))).detail : '';
                if (status) status.textContent = Lang.t('harvester.setup_error') + (detail ? ': ' + detail : '');
                return;
            }
            const data = await r.json();
            document.getElementById('hrv-recipe').value = JSON.stringify(data.recipe, null, 2);
            document.getElementById('hrv-plan').value = JSON.stringify(data.plan || {}, null, 2);
            if (status) status.textContent = Lang.t('harvester.generated_ok') + ' · ' + Lang.t('harvester.difficulty') + ': ' + data.difficulty;
            this._renderPreview(data.sample || []);
        } catch (e) {
            if (status) status.textContent = Lang.t('harvester.setup_error');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    _renderPreview(sample) {
        const host = document.getElementById('hrv-preview');
        if (!host) return;
        if (!sample.length) { host.innerHTML = ''; return; }
        const cols = Object.keys(sample[0]);
        const head = cols.map(function (c) { return '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border);">' + esc(c) + '</th>'; }).join('');
        const rows = sample.slice(0, 5).map(function (rec) {
            return '<tr>' + cols.map(function (c) { return '<td style="padding:4px 8px;border-bottom:1px solid var(--border);">' + esc(rec[c] || '') + '</td>'; }).join('') + '</tr>';
        }).join('');
        host.innerHTML = '<div class="form-label" style="margin-top:12px;">' + Lang.t('harvester.preview') + '</div>' +
            '<div style="overflow:auto;"><table style="border-collapse:collapse;font-family:var(--font-mono);font-size:12px;width:100%;"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    },

    async start() {
        let recipe, plan;
        try {
            recipe = JSON.parse(document.getElementById('hrv-recipe').value);
            plan = JSON.parse(document.getElementById('hrv-plan').value);
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.error(Lang.t('harvester.invalid_json'));
            return;
        }
        // Toggles → plan : tier de fetch (furtif OU débloqueur, exclusifs) +
        // déduplication des records.
        const stealthEl = document.getElementById('hrv-stealth');
        const unblockerEl = document.getElementById('hrv-unblocker');
        const dedupeEl = document.getElementById('hrv-dedupe');
        if (plan && typeof plan === 'object') {
            if (unblockerEl && unblockerEl.checked) plan.fetch_tier = 'unblocker';
            else if (stealthEl && stealthEl.checked) plan.fetch_tier = 'stealth';
            else delete plan.fetch_tier;
            if (dedupeEl && dedupeEl.checked) plan.dedupe = true;
            else delete plan.dedupe;
        }
        const url = document.getElementById('hrv-url').value.trim();
        const r = await Auth.apiCall('/api/bots/harvester/run', {
            method: 'POST',
            body: JSON.stringify({ url, recipe, plan }),
        });
        if (!r || !r.ok) {
            const detail = r ? (await r.json().catch(() => ({}))).detail : '';
            if (typeof Toast !== 'undefined') Toast.error(detail || 'Error');
            return;
        }
        const data = await r.json();
        this._jobId = data.job_id;
        this._feedKey = data.feed_key;
        this._renderRunning({ job_id: data.job_id, counts: { records: 0, done: 0, errors: 0 } });
        this._startPolling();
    },

    _renderRunning(state) {
        const c = this._container;
        const counts = state.counts || { records: 0, done: 0, errors: 0 };
        const tierLabel = this._tierLabel(state.tier);
        c.innerHTML = `
        <div class="card">
          <div class="b-head" style="margin-bottom:12px;">
            <span class="b-icon b-ticker">HRV</span>
            <div class="b-name-wrap"><div class="b-name">${Lang.t('harvester.title')}</div>
            <div class="b-type">${Lang.t('harvester.running')}</div></div>
            <span class="badge" id="hrv-tier" style="margin-left:auto;">${tierLabel}</span>
            <span class="badge online" id="hrv-status" style="margin-left:6px;">running</span>
          </div>
          <div id="hrv-reco" style="display:none;margin-bottom:12px;padding:10px 12px;border-radius:var(--r-md);background:var(--bg-elev-3);border:1px solid var(--warning);color:var(--text);font-size:13px;"></div>
          <div class="bento-overview" style="margin-bottom:12px;">
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.records')}</div><div class="stat-value" id="hrv-records">${counts.records || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.pages_done')}</div><div class="stat-value" id="hrv-done">${counts.done || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.queue')}</div><div class="stat-value" id="hrv-todo">${counts.todo || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.errors')}</div><div class="stat-value" id="hrv-errors">${counts.errors || 0}</div></div>
          </div>
          <div style="margin-top:14px;">
            <label class="form-label">${Lang.t('harvester.feed_key')}</label>
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <code id="hrv-feedkey" style="flex:1;display:block;padding:8px;background:var(--bg-elev-3);border-radius:var(--r-sm);word-break:break-all;">${this._feedKey || '—'}</code>
              <button class="btn btn-sm btn-ghost" onclick="HarvesterModule.copyKey()">${Lang.t('harvester.copy_key')}</button>
            </div>
            <div class="form-hint">${Lang.t('harvester.feed_key_hint')}</div>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-danger" onclick="HarvesterModule.stop()">${Lang.t('harvester.stop')}</button>
            <button class="btn btn-ghost" onclick="HarvesterModule.viewData()">${Lang.t('harvester.view_data')}</button>
            <button class="btn btn-ghost" onclick="HarvesterModule.download('csv')">${Lang.t('harvester.download_csv')}</button>
            <button class="btn btn-ghost" onclick="HarvesterModule.download('json')">${Lang.t('harvester.download_json')}</button>
            <button class="btn btn-secondary" onclick="HarvesterModule.exportClient()">${Lang.t('harvester.export')}</button>
            <button class="btn btn-ghost" onclick="BotsModule.render(BotsModule._container)">${Lang.t('harvester.back')}</button>
          </div>
          <div class="form-hint">${Lang.t('harvester.export_hint')}</div>
          <pre id="hrv-data" style="margin-top:12px;max-height:240px;overflow:auto;font-family:var(--font-mono);font-size:12px;"></pre>
        </div>`;
    },

    _startPolling() {
        if (this._pollInterval) clearInterval(this._pollInterval);
        this._poll();
        this._pollInterval = setInterval(() => this._poll(), 3000);
    },

    async _poll() {
        if (!this._jobId) return;
        try {
            const r = await Auth.apiCall(`/api/bots/harvester/status/${this._jobId}`);
            if (!r || !r.ok) return;
            const data = await r.json();
            const counts = data.counts || {};
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            set('hrv-records', counts.records || 0);
            set('hrv-done', counts.done || 0);
            set('hrv-todo', counts.todo || 0);
            set('hrv-errors', counts.errors || 0);
            if (data.feed_key) { this._feedKey = data.feed_key; set('hrv-feedkey', data.feed_key); }
            const tierEl = document.getElementById('hrv-tier');
            if (tierEl && data.tier) tierEl.textContent = this._tierLabel(data.tier);
            // Reco de tier : la cible bloque -> bandeau visible (sauf si déjà au
            // tier débloqueur). Le déclencheur est déterministe côté moteur.
            const recoEl = document.getElementById('hrv-reco');
            if (recoEl) {
                if (data.recommend && data.tier !== 'unblocker') {
                    // label i18n + compteur neutre (la `reason` du moteur est en FR
                    // -> on ne la concatène pas pour éviter un bandeau bilingue).
                    const n = data.recommend.consecutive_blocks;
                    const suffix = (typeof n === 'number' && n > 0) ? ' (' + n + ')' : '';
                    recoEl.textContent = Lang.t('harvester.reco_unblocker') + suffix;
                    recoEl.style.display = '';
                } else {
                    recoEl.style.display = 'none';
                }
            }
            const st = document.getElementById('hrv-status');
            if (st) {
                st.textContent = data.status;
                const cls = data.status === 'running' ? 'online'
                    : (data.status === 'interrupted' || data.status === 'error' ? 'warn' : '');
                st.className = 'badge' + (cls ? ' ' + cls : '');
            }
            // 'interrupted' n'est PAS terminal : le run sera repris au prochain
            // boot -> on continue de poller pour voir le retour à 'running'.
            if (['completed', 'error', 'stopped'].includes(data.status)) {
                clearInterval(this._pollInterval); this._pollInterval = null;
            }
        } catch (e) { /* ignore */ }
    },

    async stop() {
        if (!this._jobId) return;
        await Auth.apiCall(`/api/bots/harvester/stop/${this._jobId}`, { method: 'POST' });
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    },

    async viewData() {
        if (!this._jobId || !this._feedKey) return;
        const r = await Auth.apiCall(`/api/bots/harvester/data/${this._jobId}`, {
            headers: { 'X-Feed-Key': this._feedKey },
        });
        if (!r || !r.ok) return;
        const data = await r.json();
        const el = document.getElementById('hrv-data');
        if (el) el.textContent = JSON.stringify(data.records.slice(0, 20), null, 2);
    },

    async copyKey() {
        if (!this._feedKey) return;
        try {
            await navigator.clipboard.writeText(this._feedKey);
            if (typeof Toast !== 'undefined' && Toast.success) Toast.success(Lang.t('harvester.key_copied'));
        } catch (e) { /* clipboard indisponible (http non sécurisé) — ignore */ }
    },

    async download(format) {
        if (!this._jobId || !this._feedKey) return;
        const r = await Auth.apiCall(`/api/bots/harvester/data/${this._jobId}?format=${format}`, {
            headers: { 'X-Feed-Key': this._feedKey },
        });
        if (!r || !r.ok) return;
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `harvest-${this._jobId}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    },

    async exportClient() {
        // Génère le package client standalone (zip) et le télécharge.
        if (!this._jobId) return;
        const r = await Auth.apiCall(`/api/bots/harvester/export/${this._jobId}`, { method: 'POST' });
        if (!r || !r.ok) {
            const d = r ? (await r.json().catch(() => ({}))) : {};
            if (typeof Toast !== 'undefined') Toast.error(d.detail || 'Export error');
            return;
        }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `harvest-${this._jobId.slice(0, 8)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (typeof Toast !== 'undefined' && Toast.success) Toast.success(Lang.t('harvester.export_done'));
    },
};
