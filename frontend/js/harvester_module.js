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
                title: { selector: { tag: 'a' }, extract: 'attr:title' },
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
            this._renderRunning(active);
            this._startPolling();
        } else {
            this._renderForm();
        }
    },

    unload() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
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
          <label class="form-label">${Lang.t('harvester.form_recipe')}</label>
          <textarea id="hrv-recipe" class="form-input" rows="10" style="font-family:var(--font-mono);">${this._demoRecipe()}</textarea>
          <label class="form-label">${Lang.t('harvester.form_plan')}</label>
          <textarea id="hrv-plan" class="form-input" rows="4" style="font-family:var(--font-mono);">${this._demoPlan()}</textarea>
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="HarvesterModule.start()">${Lang.t('harvester.start')}</button>
            <button class="btn btn-ghost" onclick="BotsModule.render(BotsModule._container)">${Lang.t('harvester.back')}</button>
          </div>
        </div>`;
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
        const keyBlock = this._feedKey ? `
          <div style="margin-top:14px;">
            <label class="form-label">${Lang.t('harvester.feed_key')}</label>
            <code style="display:block;padding:8px;background:var(--bg-elev-3);border-radius:var(--r-sm);word-break:break-all;">${this._feedKey}</code>
            <div class="form-hint">${Lang.t('harvester.feed_key_hint')}</div>
          </div>` : '';
        c.innerHTML = `
        <div class="card">
          <div class="b-head" style="margin-bottom:12px;">
            <span class="b-icon b-ticker">HRV</span>
            <div class="b-name-wrap"><div class="b-name">${Lang.t('harvester.title')}</div>
            <div class="b-type">${Lang.t('harvester.running')}</div></div>
            <span class="badge online" id="hrv-status">running</span>
          </div>
          <div class="bento-overview" style="margin-bottom:12px;">
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.records')}</div><div class="stat-value" id="hrv-records">${counts.records || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.pages_done')}</div><div class="stat-value" id="hrv-done">${counts.done || 0}</div></div>
            <div class="stat-card"><div class="stat-label">${Lang.t('harvester.errors')}</div><div class="stat-value" id="hrv-errors">${counts.errors || 0}</div></div>
          </div>
          ${keyBlock}
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-danger" onclick="HarvesterModule.stop()">${Lang.t('harvester.stop')}</button>
            <button class="btn btn-ghost" onclick="HarvesterModule.viewData()">${Lang.t('harvester.view_data')}</button>
            <button class="btn btn-ghost" onclick="BotsModule.render(BotsModule._container)">${Lang.t('harvester.back')}</button>
          </div>
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
            set('hrv-errors', counts.errors || 0);
            const st = document.getElementById('hrv-status');
            if (st) st.textContent = data.status;
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
};
