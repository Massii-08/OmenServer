// frontend/js/stockscan_module.js
// Vue dédiée Scanner d'actions — 4e bot de la suite finance, frère du Bond
// Scanner. Trois états : réglages → exécution → résultats classés.
//
// Contrat unique : le results.json du moteur (spec 2026-10-17 §7.3), servi par
// /api/bots/stocks/*. Le scanner présente des FAITS filtrés et leurs raisons,
// jamais « à acheter » (ligne rouge §2) : le rappel reste visible en tête,
// quel que soit l'état.
//
// Règles du dépôt respectées ici :
//   - vanilla JS, zéro dépendance ; composants Bento + style inline minimal,
//     couleurs UNIQUEMENT par tokens (mode sombre et mode clair « Givre ») ;
//   - toute donnée dynamique passe par esc() avant innerHTML, toute URL est
//     vérifiée (http/https) avant d'aller dans un href ;
//   - tout texte d'interface passe par Lang.t('stocks.*') (FR/EN/IT) ;
//   - appels API uniquement via Auth.apiCall() ;
//   - un seul écouteur délégué (data-*), RETIRÉ dans unload() : le conteneur
//     (#module-content) survit aux vues, un écouteur oublié s'empilerait à
//     chaque ouverture ;
//   - le sondage ne survit jamais au module (génération + présence du DOM) :
//     le Bond Scanner écrivait dans une autre vue après qu'on l'avait quitté.
const StockScanModule = {
    // Les six étapes du moteur, dans l'ordre (spec §5) : la barre globale
    // avance d'une étape à l'autre, et à l'intérieur d'une étape quand le
    // moteur publie done/total.
    PHASES: ['universe', 'coach', 'shortlist', 'news', 'scoring', 'output'],
    // Défauts de secours si /config ne les rend pas (miroir de config.py).
    FALLBACK: { min_cap_meur: 1000, min_value_meur: 5, window_h: 48, top_n: 25, shortlist: 40, exclude_red: false },
    CAP_OPTIONS: [100, 500, 1000, 5000, 20000],
    VALUE_OPTIONS: [1, 5, 20, 50],
    COUNT_KEYS: ['universe', 'shortlist', 'news_requests', 'news_failed', 'kept',
                 'excluded_no_catalyst', 'excluded_red', 'filtered_advice', 'dropped_irrelevant', 'coach_events'],
    _MONO: "font-family:var(--font-mono);font-feature-settings:'tnum';",
    _CHIP: 'display:inline-block;padding:2px 8px;font-size:12px;line-height:1.5;color:var(--text-muted);' +
           'background:var(--bg-elev-3);border:1px solid var(--border);border-radius:var(--r-pill);',
    _POS_BADGE: 'color:var(--accent);background:var(--accent-dim);border-color:transparent;',

    _container: null,
    _onClick: null,
    _onInput: null,
    _gen: 0,                 // incrémenté à chaque rendu/déchargement : invalide l'asynchrone en vol
    _pollInterval: null,
    _pollToken: null,
    _busy: false,            // chargement en cours (ouverture, fin de run)
    _config: null,
    _configError: false,
    _jobId: null,            // run suivi (en cours)
    _running: false,
    _stopping: false,
    _launching: false,
    _lastStatus: null,
    _results: null,
    _resultsJob: null,
    _resultsShown: null,     // objet results déjà dessiné (évite de replier les news ouvertes)
    _ranAt: null,
    _excel: null,            // {job, name} appris de /status
    _notice: null,           // {status, job, logs, previous} d'un run qui n'a pas abouti
    _settingsOpen: false,
    _warnings: [],           // avertissements renvoyés par POST /run
    _followed: null,         // symboles ajoutés au simulateur pendant la session

    // ------------------------------------------------------------- cycle de vie

    async render(container) {
        this.unload();                       // coupe tout reste d'un rendu précédent
        this._container = container;
        const gen = ++this._gen;
        this._busy = true;
        this._running = false;
        this._stopping = false;
        this._launching = false;
        this._jobId = null;
        this._lastStatus = null;
        this._results = null;
        this._resultsJob = null;
        this._resultsShown = null;
        this._ranAt = null;
        this._excel = null;
        this._notice = null;
        this._settingsOpen = false;
        this._warnings = [];
        if (!this._followed) this._followed = Object.create(null);
        container.innerHTML = this._shell();
        this._bind();

        const both = await Promise.all([this._loadConfig(), this._fetchActive()]);
        if (gen !== this._gen) return;
        const active = both[1];
        this._renderSettings();
        if (active && active.found && active.status === 'running' && active.job_id) {
            this._busy = false;
            this._attach(active.job_id, { progress: active.progress || null, logs: [] });
            return;
        }
        const latest = await this._loadLatest();
        if (gen !== this._gen) return;
        this._applyLatest(latest);
        // Le run le plus récent n'a pas abouti (erreur, arrêt sans résultat) :
        // on le DIT au lieu de montrer de vieux résultats comme s'ils étaient frais.
        if (active && active.found && active.job_id &&
            (active.status === 'error' || active.status === 'stopped') &&
            active.job_id !== this._resultsJob) {
            this._notice = { status: active.status, job: active.job_id, logs: [], previous: !!this._results };
            this._fetchNoticeLogs(active.job_id, gen);
        }
        this._busy = false;
        this._layout();
    },

    unload() {
        this._gen++;
        this._stopPolling();
        this._pollToken = null;
        if (this._container) {
            if (this._onClick) this._container.removeEventListener('click', this._onClick);
            if (this._onInput) this._container.removeEventListener('input', this._onInput);
        }
        this._onClick = null;
        this._onInput = null;
    },

    back() {
        this.unload();
        if (typeof BotsModule !== 'undefined' && BotsModule.render) BotsModule.render(BotsModule._container);
    },

    // ------------------------------------------------------------- outils

    _has(key) {
        return Lang.t(key) !== key;
    },

    // Lang.t + remplacement des {variables}. Une variable absente devient « — »,
    // jamais « undefined ».
    _tr(key, vars) {
        const s = String(Lang.t(key));
        if (!vars) return s;
        return s.replace(/\{(\w+)\}/g, (m, k) => {
            const v = vars[k];
            return (v === null || v === undefined || v === '') ? '—' : String(v);
        });
    },

    _locale() {
        const l = Lang.t('common.locale');
        return (l && l !== 'common.locale') ? l : 'fr-FR';
    },

    _isNum(v) {
        if (v === null || v === undefined || v === '' || typeof v === 'boolean') return false;
        return isFinite(Number(v));
    },

    _num(v, dec) {
        if (!this._isNum(v)) return '—';
        const n = Number(v);
        const d = (dec === null || dec === undefined) ? 2 : dec;
        try {
            return new Intl.NumberFormat(this._locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
        } catch (e) {
            return n.toFixed(d);
        }
    },

    // « +2,31 % » / « -0,40 % » selon la langue ; un zéro arrondi n'a pas de signe.
    _pct(v, dec, signed) {
        if (!this._isNum(v)) return '—';
        const n = Number(v);
        const d = (dec === null || dec === undefined) ? 2 : dec;
        const abs = Math.abs(n);
        const zero = Number(abs.toFixed(d)) === 0;
        const sign = zero ? '' : (n < 0 ? '-' : (signed ? '+' : ''));
        try {
            return sign + new Intl.NumberFormat(this._locale(), {
                style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d,
            }).format(abs / 100);
        } catch (e) {
            return sign + abs.toFixed(d) + '%';
        }
    },

    _meur(v) {
        if (!this._isNum(v)) return '—';
        return this._tr('stocks.meur', { v: this._num(v, Math.abs(Number(v)) >= 100 ? 0 : 1) });
    },

    _dateTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        try {
            return d.toLocaleString(this._locale(), {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
            });
        } catch (e) {
            return d.toISOString().slice(0, 16).replace('T', ' ');
        }
    },

    // « 2026-10-24 » lu comme un JOUR (pas de décalage de fuseau).
    _date(iso) {
        const m = String(iso == null ? '' : iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return '—';
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (isNaN(d.getTime())) return '—';
        try {
            return d.toLocaleDateString(this._locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
        } catch (e) {
            return m[3] + '/' + m[2] + '/' + m[1];
        }
    },

    _age(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const min = Math.floor((Date.now() - d.getTime()) / 60000);
        if (min < 1) return Lang.t('stocks.age_now');       // y compris un horodatage « futur »
        if (min < 60) return this._tr('stocks.age_min', { n: min });
        const h = Math.floor(min / 60);
        if (h < 48) return this._tr('stocks.age_h', { n: h });
        return this._tr('stocks.age_d', { n: Math.floor(h / 24) });
    },

    _safeUrl(u) {
        const s = String(u == null ? '' : u).trim();
        return /^https?:\/\//i.test(s) ? s : '';
    },

    // Un titre fait une ligne lisible : URL nue retirée, coupe propre à un mot.
    _headline(raw, max) {
        let s = String(raw == null ? '' : raw).replace(/https?:\/\/\S+/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        const limit = max || 190;
        if (s.length <= limit) return s;
        const cut = s.slice(0, limit);
        const space = cut.lastIndexOf(' ');
        return (space > limit * 0.6 ? cut.slice(0, space) : cut) + '…';
    },

    // Valeur brute d'un avertissement, lisible et bornée.
    _plain(v) {
        if (v === null || v === undefined) return '';
        let s;
        if (typeof v === 'object') {
            try { s = JSON.stringify(v); } catch (e) { s = String(v); }
        } else {
            s = String(v);
        }
        return s.length > 60 ? s.slice(0, 57) + '…' : s;
    },

    _marketLabel(id) {
        const raw = String(id == null ? '' : id);
        const list = (this._config && Array.isArray(this._config.markets)) ? this._config.markets : [];
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (m && m.id === raw) {
                const labels = (m.labels && typeof m.labels === 'object') ? m.labels : {};
                return labels[Lang.current] || m.label || raw;
            }
        }
        return raw || '—';
    },

    _fieldLabel(f) {
        const map = {
            markets: 'stocks.markets', min_cap_meur: 'stocks.min_cap', min_value_meur: 'stocks.min_value',
            window_h: 'stocks.window', top_n: 'stocks.top_n', shortlist: 'stocks.shortlist',
            exclude_red: 'stocks.exclude_red', lang: 'stocks.field_lang',
        };
        const k = map[f];
        return k ? Lang.t(k) : String(f == null ? '' : f);
    },

    async _json(r) {
        try { return await r.json(); } catch (e) { return null; }
    },

    _el(id) {
        return document.getElementById(id);
    },

    // ------------------------------------------------------------- coquille

    _shell() {
        return '' +
        '<div class="card" style="margin-bottom:14px;">' +
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<span class="b-ticker">ACT</span>' +
            '<div style="flex:1 1 200px;min-width:0;">' +
              '<div style="font-weight:600;font-size:16px;letter-spacing:-0.01em;">' + esc(Lang.t('stocks.title')) + '</div>' +
              '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">' + esc(Lang.t('stocks.subtitle')) + '</div>' +
            '</div>' +
            '<span class="badge" id="stk-status" style="display:none;"></span>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:12px;">' +
            esc(Lang.t('stocks.desc')) + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn btn-primary" id="stk-new-btn" data-stk-act="new" style="display:none;">' +
              esc(Lang.t('stocks.new_scan')) + '</button>' +
            '<button class="btn btn-ghost" id="stk-dl-btn" data-stk-act="download" style="display:none;">' +
              esc(Lang.t('stocks.download_excel')) + '</button>' +
            '<button class="btn btn-ghost" data-stk-act="back">' + esc(Lang.t('stocks.back')) + '</button>' +
          '</div>' +
        '</div>' +
        // Rappel « outil d'étude » : toujours visible, juste sous l'en-tête.
        '<div class="card" style="margin-bottom:14px;border-color:var(--warning);background:var(--bg-elev-2);' +
             'font-size:14px;line-height:1.5;">' + esc(Lang.t('stocks.disclaimer')) + '</div>' +
        // Conteneurs SÉPARÉS : le sondage (3 s) ne réécrit que #stk-run, jamais
        // un formulaire qu'on est en train de remplir.
        '<div id="stk-msg"></div>' +
        '<div id="stk-run" style="display:none;"></div>' +
        '<div id="stk-settings" style="display:none;"></div>' +
        '<div id="stk-results" style="display:none;"></div>' +
        '<div id="stk-loading" class="card" style="text-align:center;color:var(--text-muted);padding:24px;">' +
          esc(Lang.t('stocks.loading')) + '</div>';
    },

    // Un seul écouteur délégué ; les boutons porteurs de DONNÉES passent par
    // data-* (jamais un onclick avec une valeur interpolée — audit 2026-06-21).
    _bind() {
        if (!this._container || this._onClick) return;
        this._onClick = (ev) => {
            const t = (ev.target && ev.target.closest) ? ev.target : null;
            if (!t || !this._container) return;
            const fol = t.closest('[data-stk-follow]');
            if (fol && this._container.contains(fol)) {
                ev.preventDefault();
                this.follow(fol);
                return;
            }
            const act = t.closest('[data-stk-act]');
            if (!act || !this._container.contains(act)) return;
            ev.preventDefault();
            switch (act.getAttribute('data-stk-act')) {
                case 'back': this.back(); break;
                case 'new': this.openSettings(); break;
                case 'cancel': this.closeSettings(); break;
                case 'launch': this.launch(); break;
                case 'stop': this.stop(); break;
                case 'download': this.download(); break;
                case 'retry': this.retryConfig(); break;
                case 'dismiss': this._notice = null; this._layout(); break;
                case 'dismiss-warn': this._warnings = []; this._renderMsg(); break;
                default: break;
            }
        };
        this._onInput = (ev) => {
            const el = ev.target;
            if (el && el.getAttribute && el.getAttribute('data-stk-range') !== null) this._onRange(el);
        };
        this._container.addEventListener('click', this._onClick);
        this._container.addEventListener('input', this._onInput);
    },

    // Visibilité des régions selon l'état. Ne redessine les résultats QUE s'ils
    // ont changé : ouvrir les réglages ne doit pas replier une news dépliée.
    _layout() {
        const busy = !!this._busy;
        const loading = this._el('stk-loading');
        if (loading) loading.style.display = busy ? '' : 'none';

        const run = this._el('stk-run');
        if (run) {
            if (this._running) {
                run.style.display = '';            // le contenu vient de _renderRunning
            } else if (this._notice) {
                run.style.display = '';
                run.innerHTML = this._noticeHtml();
            } else {
                run.style.display = 'none';
                run.innerHTML = '';
            }
        }

        const idle = !busy && !this._running;
        const settings = this._el('stk-settings');
        if (settings) settings.style.display = (idle && (this._settingsOpen || !this._results)) ? '' : 'none';
        const cancel = this._el('stk-cancel-btn');
        if (cancel) cancel.style.display = this._results ? '' : 'none';
        const never = this._el('stk-never');
        if (never) never.style.display = this._results ? 'none' : '';

        const res = this._el('stk-results');
        if (res) {
            const on = idle && !!this._results;
            res.style.display = on ? '' : 'none';
            if (on && this._resultsShown !== this._results) this._renderResults();
        }
        this._paintHeader();
    },

    _paintHeader() {
        const st = this._el('stk-status');
        if (st) {
            st.textContent = this._running ? Lang.t('stocks.running') : '';
            st.className = 'badge' + (this._running ? ' online' : '');
            st.style.display = this._running ? '' : 'none';
        }
        const idle = !this._busy && !this._running;
        const nb = this._el('stk-new-btn');
        if (nb) nb.style.display = (idle && this._results && !this._settingsOpen) ? '' : 'none';
        const dl = this._el('stk-dl-btn');
        if (dl) dl.style.display = (idle && this._results && this._resultsJob) ? '' : 'none';
    },

    // ------------------------------------------------------------- chargement

    async _loadConfig() {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/config'); } catch (e) { r = null; }
        const d = (r && r.ok) ? await this._json(r) : null;
        if (d && typeof d === 'object') {
            this._config = d;
            this._configError = false;
            return true;
        }
        this._configError = true;
        return false;
    },

    async _fetchActive() {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/active'); } catch (e) { r = null; }
        if (!r || !r.ok) return null;
        const d = await this._json(r);
        return (d && typeof d === 'object') ? d : null;
    },

    async _loadLatest() {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/latest'); } catch (e) { r = null; }
        if (!r || !r.ok) return null;
        const d = await this._json(r);
        return (d && typeof d === 'object') ? d : null;
    },

    _applyLatest(d) {
        if (d && d.results && typeof d.results === 'object') {
            this._results = d.results;
            this._resultsJob = d.job_id || null;
            this._ranAt = d.ran_at || null;
        }
    },

    async _loadResults(job) {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/results/' + encodeURIComponent(job)); } catch (e) { r = null; }
        if (!r || !r.ok) return null;
        const d = await this._json(r);
        return (d && typeof d === 'object') ? d : null;
    },

    async retryConfig() {
        const gen = this._gen;
        const host = this._el('stk-settings');
        if (host) host.innerHTML = this._settingsHtml(true);
        await this._loadConfig();
        if (gen !== this._gen) return;
        this._renderSettings();
        this._resultsShown = null;               // les libellés des marchés ont pu arriver
        this._layout();
    },

    async _fetchNoticeLogs(job, gen) {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/status/' + encodeURIComponent(job)); } catch (e) { r = null; }
        const d = (r && r.ok) ? await this._json(r) : null;
        if (gen !== this._gen || !this._notice || this._notice.job !== job || !d) return;
        if (Array.isArray(d.logs) && d.logs.length) {
            this._notice.logs = d.logs.slice(-15);
            this._layout();
        }
    },

    // ------------------------------------------------------------- réglages

    _renderSettings() {
        const host = this._el('stk-settings');
        if (host) host.innerHTML = this._settingsHtml(false);
    },

    _options(list, value, label) {
        const vals = list.slice();
        const v = Number(value);
        if (isFinite(v) && vals.indexOf(v) < 0) {
            vals.push(v);
            vals.sort((a, b) => a - b);
        }
        return vals.map(n => '<option value="' + esc(String(n)) + '"' + (n === v ? ' selected' : '') + '>' +
            esc(label(n)) + '</option>').join('');
    },

    _range(id, valId, label, min, max, value) {
        const mono = this._MONO;
        return '<div style="margin-top:14px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">' +
              '<label class="form-label" for="' + id + '" style="margin:0;">' + esc(label) + '</label>' +
              '<span id="' + valId + '" style="' + mono + 'font-size:14px;font-weight:600;">' + esc(String(value)) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:10px;margin-top:6px;">' +
              '<span style="font-size:11px;color:var(--text-dim);' + mono + '">' + esc(String(min)) + '</span>' +
              '<input type="range" id="' + id + '" data-stk-range="' + valId + '" min="' + esc(String(min)) +
                '" max="' + esc(String(max)) + '" step="1" value="' + esc(String(value)) + '" ' +
                'style="flex:1;min-width:0;accent-color:var(--accent);cursor:pointer;" />' +
              '<span style="font-size:11px;color:var(--text-dim);' + mono + '">' + esc(String(max)) + '</span>' +
            '</div>' +
        '</div>';
    },

    _settingsHtml(loading) {
        const cfg = this._config;
        if (!cfg || loading) {
            const err = !loading && this._configError;
            return '<div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                '<span style="color:var(--text-muted);font-size:14px;">' +
                  esc(Lang.t(err ? 'stocks.error_config' : 'stocks.loading')) + '</span>' +
                (err ? '<button class="btn btn-ghost btn-sm" data-stk-act="retry">' + esc(Lang.t('stocks.retry')) + '</button>' : '') +
            '</div>';
        }
        const def = Object.assign({}, this.FALLBACK, (cfg.defaults && typeof cfg.defaults === 'object') ? cfg.defaults : {});
        const catalogue = Array.isArray(cfg.markets) ? cfg.markets.filter(m => m && m.id) : [];
        const chosen = Array.isArray(def.markets) ? def.markets.map(String)
            : catalogue.filter(m => m.default).map(m => String(m.id));
        const lim = (cfg.limits && typeof cfg.limits === 'object') ? cfg.limits : {};
        const span = (k, lo, hi) => {
            const v = lim[k];
            return (Array.isArray(v) && v.length === 2 && isFinite(Number(v[0])) && isFinite(Number(v[1])))
                ? [Number(v[0]), Number(v[1])] : [lo, hi];
        };
        const topR = span('top_n', 5, 80);
        const shortR = span('shortlist', 10, 80);
        const capR = span('min_cap_meur', 50, 500000);
        const valR = span('min_value_meur', 0, 10000);
        const clampInt = (v, r, fb) => {
            let n = Math.round(Number(v));
            if (!isFinite(n)) n = fb;
            return Math.min(r[1], Math.max(r[0], n));
        };
        const topN = clampInt(def.top_n, topR, this.FALLBACK.top_n);
        // La présélection n'est jamais plus courte que la liste rendue.
        const shortlist = Math.max(clampInt(def.shortlist, shortR, this.FALLBACK.shortlist), Math.min(topN, shortR[1]));
        const windows = (Array.isArray(cfg.windows) && cfg.windows.length)
            ? cfg.windows.map(Number).filter(n => isFinite(n) && n > 0) : [24, 48, 72];
        const caps = this.CAP_OPTIONS.filter(n => n >= capR[0] && n <= capR[1]);
        const vals = this.VALUE_OPTIONS.filter(n => n >= valR[0] && n <= valR[1]);
        const mono = this._MONO;

        const markets = catalogue.length
            ? '<div style="display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));">' +
              catalogue.map(m => {
                  const labels = (m.labels && typeof m.labels === 'object') ? m.labels : {};
                  const label = labels[Lang.current] || m.label || m.id;
                  const on = chosen.indexOf(String(m.id)) >= 0;
                  return '<label style="display:flex;align-items:center;gap:9px;cursor:pointer;padding:8px 10px;' +
                         'border:1px solid var(--border);border-radius:var(--r-md);min-width:0;">' +
                      '<input type="checkbox" class="stk-mkt" value="' + esc(String(m.id)) + '"' + (on ? ' checked' : '') +
                        ' style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex:0 0 auto;" />' +
                      '<span style="font-size:14px;min-width:0;overflow-wrap:anywhere;">' + esc(label) + '</span>' +
                      (m.currency ? '<span style="margin-left:auto;font-size:11px;color:var(--text-dim);' + mono + '">' +
                          esc(String(m.currency)) + '</span>' : '') +
                  '</label>';
              }).join('') + '</div>'
            : '<div style="font-size:14px;color:var(--text-muted);">' + esc(Lang.t('stocks.no_markets')) + '</div>';

        const select = (id, label, opts) =>
            '<div style="flex:1 1 180px;min-width:0;">' +
              '<label class="form-label" for="' + id + '">' + esc(label) + '</label>' +
              '<select id="' + id + '" class="form-input">' + opts + '</select>' +
            '</div>';

        return '<div class="card" style="margin-bottom:14px;">' +
            '<h3 style="margin:0 0 6px;font-size:17px;">' + esc(Lang.t('stocks.settings_title')) + '</h3>' +
            '<div id="stk-never" style="font-size:13px;color:var(--text-dim);margin-bottom:4px;">' +
              esc(Lang.t('stocks.never_run')) + '</div>' +
            '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:12px;">' +
              esc(Lang.t('stocks.settings_hint')) + '</div>' +
            '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin-bottom:6px;">' +
              esc(Lang.t('stocks.markets')) + '</div>' +
            markets +
            '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:14px;">' +
              select('stk-mincap', Lang.t('stocks.min_cap'),
                  this._options(caps, def.min_cap_meur, n => this._tr('stocks.meur', { v: this._num(n, 0) }))) +
              select('stk-minval', Lang.t('stocks.min_value'),
                  this._options(vals, def.min_value_meur, n => this._tr('stocks.meur', { v: this._num(n, Number.isInteger(n) ? 0 : 1) }))) +
              select('stk-window', Lang.t('stocks.window'),
                  this._options(windows, def.window_h, n => this._tr('stocks.hours', { n: n }))) +
            '</div>' +
            this._range('stk-topn', 'stk-topn-val', Lang.t('stocks.top_n'), topR[0], topR[1], topN) +
            '<label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;font-size:14px;">' +
              '<input type="checkbox" id="stk-exred"' + (def.exclude_red === true ? ' checked' : '') +
                ' style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex:0 0 auto;" />' +
              '<span>' + esc(Lang.t('stocks.exclude_red')) + '</span>' +
            '</label>' +
            '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;line-height:1.5;">' + esc(Lang.t('stocks.exclude_red_hint')) + '</div>' +
            '<details style="margin-top:14px;border:1px solid var(--border);border-radius:var(--r-md);padding:0 12px;">' +
              '<summary style="cursor:pointer;padding:10px 0;font-size:13px;color:var(--text-muted);">' +
                esc(Lang.t('stocks.advanced')) + '</summary>' +
              '<div style="padding-bottom:12px;">' +
                this._range('stk-shortlist', 'stk-shortlist-val', Lang.t('stocks.shortlist'), shortR[0], shortR[1], shortlist) +
                '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;line-height:1.5;">' + esc(Lang.t('stocks.shortlist_hint')) + '</div>' +
              '</div>' +
            '</details>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px;">' +
              '<button class="btn btn-primary" id="stk-launch-btn" data-stk-act="launch">' + esc(Lang.t('stocks.launch')) + '</button>' +
              '<button class="btn btn-ghost" id="stk-cancel-btn" data-stk-act="cancel" style="display:none;">' +
                esc(Lang.t('stocks.cancel')) + '</button>' +
              '<span id="stk-form-msg" style="font-size:13px;color:var(--danger);"></span>' +
            '</div>' +
        '</div>';
    },

    // Les deux curseurs restent cohérents : la présélection ne descend jamais
    // sous le nombre de lignes (le serveur la remonterait de toute façon).
    _onRange(el) {
        const top = this._el('stk-topn');
        const sl = this._el('stk-shortlist');
        if (top && sl && (el === top || el === sl)) {
            const tn = Number(top.value);
            if (Number(sl.value) < tn) sl.value = String(Math.min(tn, Number(sl.max) || tn));
            const so = this._el('stk-shortlist-val');
            if (so) so.textContent = sl.value;
        }
        const out = this._el(el.getAttribute('data-stk-range'));
        if (out) out.textContent = el.value;
    },

    openSettings() {
        if (this._running) return;
        this._renderSettings();
        this._settingsOpen = true;
        this._layout();
        const host = this._el('stk-settings');
        if (host && host.scrollIntoView) {
            try { host.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ }
        }
    },

    closeSettings() {
        this._settingsOpen = false;
        this._formMsg('');
        this._layout();
    },

    _formMsg(text) {
        const m = this._el('stk-form-msg');
        if (m) m.textContent = text || '';
    },

    _collect() {
        const host = this._el('stk-settings');
        if (!host) return null;
        const markets = [];
        host.querySelectorAll('input.stk-mkt').forEach(el => { if (el.checked) markets.push(el.value); });
        if (!markets.length) {
            this._formMsg(Lang.t('stocks.need_market'));
            return null;
        }
        const def = Object.assign({}, this.FALLBACK, (this._config && this._config.defaults) || {});
        const num = (id, fb) => {
            const el = this._el(id);
            const n = el ? Number(el.value) : NaN;
            return isFinite(n) ? n : fb;
        };
        const ex = this._el('stk-exred');
        const lang = ['fr', 'en', 'it'].indexOf(Lang.current) >= 0 ? Lang.current : 'fr';
        return {
            markets: markets,
            min_cap_meur: num('stk-mincap', def.min_cap_meur),
            min_value_meur: num('stk-minval', def.min_value_meur),
            window_h: Math.round(num('stk-window', def.window_h)),
            top_n: Math.round(num('stk-topn', def.top_n)),
            shortlist: Math.round(num('stk-shortlist', def.shortlist)),
            exclude_red: !!(ex && ex.checked),
            lang: lang,
        };
    },

    // ------------------------------------------------------------- lancement

    async launch() {
        if (this._launching || this._running) return;
        const body = this._collect();
        if (!body) return;
        this._launching = true;
        this._formMsg('');
        const btn = this._el('stk-launch-btn');
        if (btn) { btn.disabled = true; btn.textContent = Lang.t('stocks.launching'); }
        const gen = this._gen;
        let r = null;
        try {
            r = await Auth.apiCall('/api/bots/stocks/run', { method: 'POST', body: JSON.stringify(body) });
        } catch (e) { r = null; }
        const d = r ? await this._json(r) : null;
        if (gen !== this._gen) return;
        this._launching = false;
        const btn2 = this._el('stk-launch-btn');
        if (btn2) { btn2.disabled = false; btn2.textContent = Lang.t('stocks.launch'); }
        if (!r) { this._formMsg(Lang.t('stocks.error')); return; }   // 401 / réseau : Auth a déjà prévenu
        if (!r.ok || !d || !d.job_id) {
            const detail = (d && typeof d.detail === 'string') ? d.detail : '';
            const msg = detail || (Lang.t('stocks.error') + ' (' + r.status + ')');
            this._formMsg(msg);
            if (typeof Toast !== 'undefined' && Toast.error) Toast.error(msg);
            return;
        }
        this._warnings = Array.isArray(d.warnings) ? d.warnings : [];
        this._renderMsg();
        // Le serveur enregistre la config propre comme défauts : le prochain
        // « Nouveau scan » repart de là.
        if (d.config && typeof d.config === 'object' && this._config) {
            this._config.defaults = Object.assign({}, this._config.defaults || {}, d.config);
        }
        if (d.already_running && typeof Toast !== 'undefined' && Toast.info) {
            Toast.info(Lang.t('stocks.already_running'));
        }
        this._attach(d.job_id, null);
    },

    _launchWarning(w) {
        const o = (w && typeof w === 'object') ? w : { code: String(w) };
        const code = String(o.code || '');
        const vars = { value: this._plain(o.value), used: this._plain(o.used), field: this._fieldLabel(o.field), code: code };
        const key = 'stocks.warn.' + code;
        return (code && this._has(key)) ? this._tr(key, vars) : this._tr('stocks.warn.other', vars);
    },

    _renderMsg() {
        const host = this._el('stk-msg');
        if (!host) return;
        const w = Array.isArray(this._warnings) ? this._warnings : [];
        if (!w.length) { host.innerHTML = ''; return; }
        host.innerHTML = '<div class="card" style="margin-bottom:14px;border-color:var(--warning);">' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">' +
              '<span style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);">' +
                esc(Lang.t('stocks.launch_warnings')) + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-stk-act="dismiss-warn" style="margin-left:auto;">' +
                esc(Lang.t('stocks.close')) + '</button>' +
            '</div>' +
            '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;">' +
              w.map(x => '<li style="overflow-wrap:anywhere;">' + esc(this._launchWarning(x)) + '</li>').join('') +
            '</ul>' +
        '</div>';
    },

    // ------------------------------------------------------------- exécution

    _attach(jobId, initial) {
        this._jobId = jobId;
        this._running = true;
        this._stopping = false;
        this._notice = null;
        this._settingsOpen = false;
        this._lastStatus = initial || null;
        this._layout();
        this._renderRunning(initial || null);
        this._startPolling();
        this._poll();
    },

    _startPolling() {
        this._stopPolling();
        this._pollInterval = setInterval(() => this._poll(), 3000);
    },

    _stopPolling() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    },

    async _poll() {
        if (!this._running || !this._jobId || this._pollToken) return;
        if (!this._el('stk-run')) { this._stopPolling(); return; }     // la vue est partie
        const gen = this._gen;
        const job = this._jobId;
        const token = {};
        this._pollToken = token;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/status/' + encodeURIComponent(job)); } catch (e) { r = null; }
        const d = (r && r.ok) ? await this._json(r) : null;
        if (this._pollToken === token) this._pollToken = null;
        if (gen !== this._gen || job !== this._jobId || !this._running) return;
        if (!this._el('stk-run')) { this._stopPolling(); return; }
        if (r && r.status === 404) { this._lost(gen); return; }
        if (!d || typeof d !== 'object') return;      // incident passager : on retente au prochain tick
        this._lastStatus = d;
        if (d.status === 'running') { this._renderRunning(d); return; }
        await this._finish(d, gen);
    },

    async _lost(gen) {
        this._stopPolling();
        this._running = false;
        this._notice = { status: 'lost', job: this._jobId, logs: [], previous: false };
        this._busy = true;
        this._layout();
        const latest = await this._loadLatest();
        if (gen !== this._gen) return;
        this._applyLatest(latest);
        if (this._notice) this._notice.previous = !!this._results;
        this._busy = false;
        this._layout();
    },

    // Fin d'un run, quel que soit son statut. Un arrêt reste un ARRÊT (jamais
    // affiché « erreur »), et un run sans résultat laisse voir les précédents.
    async _finish(d, gen) {
        this._stopPolling();
        this._running = false;
        this._stopping = false;
        const job = d.job_id || this._jobId;
        const files = (d.files && typeof d.files === 'object') ? d.files : {};
        if (files.excel) this._excel = { job: job, name: String(files.excel) };
        this._notice = (d.status === 'completed') ? null : {
            status: d.status === 'stopped' ? 'stopped' : 'error',
            job: job,
            logs: Array.isArray(d.logs) ? d.logs.slice(-15) : [],
            previous: false,
        };
        this._busy = true;
        this._layout();
        if (d.status === 'completed' || files.results) {
            const res = await this._loadResults(job);
            if (gen !== this._gen) return;
            if (res) {
                this._results = res;
                this._resultsJob = job;
                this._ranAt = null;
                this._settingsOpen = false;
                this._busy = false;
                this._layout();
                return;
            }
        }
        const latest = await this._loadLatest();
        if (gen !== this._gen) return;
        this._applyLatest(latest);
        if (this._notice) this._notice.previous = !!this._results;
        this._busy = false;
        this._layout();
    },

    async stop() {
        if (!this._jobId || this._stopping || !this._running) return;
        this._stopping = true;
        this._renderRunning(this._lastStatus);
        const gen = this._gen;
        let r = null;
        try {
            r = await Auth.apiCall('/api/bots/stocks/stop/' + encodeURIComponent(this._jobId), { method: 'POST' });
        } catch (e) { r = null; }
        if (gen !== this._gen) return;
        this._stopping = false;
        if (r && !r.ok && typeof Toast !== 'undefined' && Toast.error) Toast.error(Lang.t('stocks.error'));
        this._poll();                                   // relit tout de suite le statut
    },

    _renderRunning(d) {
        const host = this._el('stk-run');
        if (!host) return;
        const mono = this._MONO;
        const p = (d && d.progress && typeof d.progress === 'object') ? d.progress : null;
        const phase = (p && typeof p.phase === 'string') ? p.phase : '';
        const done = Number(p && p.done);
        const total = Number(p && p.total);
        const hasTotal = isFinite(total) && total > 0 && isFinite(done);
        const idx = this.PHASES.indexOf(phase);
        let pct = 0;
        if (phase === 'done') pct = 100;
        else if (idx >= 0) {
            const frac = hasTotal ? Math.min(1, Math.max(0, done / total)) : 0;
            pct = Math.round(((idx + frac) / this.PHASES.length) * 100);
        }
        const phaseKey = 'stocks.phase.' + phase;
        const phaseLabel = phase ? (this._has(phaseKey) ? Lang.t(phaseKey) : phase) : Lang.t('stocks.phase.starting');
        const step = idx >= 0 ? this._tr('stocks.step', { n: idx + 1, total: this.PHASES.length }) + ' — ' : '';
        const logs = (d && Array.isArray(d.logs)) ? d.logs.slice(-20).map(x => String(x == null ? '' : x)) : [];
        const stopLabel = this._stopping ? Lang.t('stocks.stopping') : Lang.t('stocks.stop');

        host.innerHTML = '<div class="card" style="margin-bottom:14px;">' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
              '<h3 style="margin:0;font-size:17px;">' + esc(Lang.t('stocks.running')) + '</h3>' +
              '<button class="btn btn-danger btn-sm" data-stk-act="stop" style="margin-left:auto;"' +
                (this._stopping ? ' disabled' : '') + '>' + esc(stopLabel) + '</button>' +
            '</div>' +
            '<div style="font-size:14px;margin-bottom:8px;overflow-wrap:anywhere;">' + esc(step + phaseLabel) + '</div>' +
            '<div class="yield-progress-bar"><div class="yield-progress-fill" style="width:' + pct +
              '%;background:var(--accent);"></div></div>' +
            '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:12px;' +
                 'color:var(--text-muted);' + mono + '">' +
              '<span>' + (hasTotal ? esc(this._num(done, 0) + ' / ' + this._num(total, 0)) : '') + '</span>' +
              '<span>' + esc(this._pct(pct, 0, false)) + '</span>' +
            '</div>' +
            this._countsHtml(p && p.counts) +
            '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin:14px 0 6px;">' +
              esc(Lang.t('stocks.log')) + '</div>' +
            '<div class="console" id="stk-log" style="max-height:220px;margin:0;">' +
              esc(logs.length ? logs.join('\n') : Lang.t('stocks.no_logs')) + '</div>' +
        '</div>';
        const log = this._el('stk-log');
        if (log) log.scrollTop = log.scrollHeight;
    },

    _countsHtml(counts) {
        const c = (counts && typeof counts === 'object') ? counts : {};
        const mono = this._MONO;
        const cells = this.COUNT_KEYS.filter(k => this._isNum(c[k])).map(k =>
            '<div style="border:1px solid var(--border);border-radius:var(--r-md);padding:8px 10px;background:var(--bg-elev-2);min-width:0;">' +
              '<div style="font-size:11px;color:var(--text-dim);overflow-wrap:anywhere;">' + esc(Lang.t('stocks.count.' + k)) + '</div>' +
              '<div style="font-size:18px;' + mono + '">' + esc(this._num(c[k], 0)) + '</div>' +
            '</div>').join('');
        return cells
            ? '<div style="display:grid;gap:8px;margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));">' + cells + '</div>'
            : '';
    },

    _noticeHtml() {
        const n = this._notice;
        if (!n) return '';
        const st = (n.status === 'stopped' || n.status === 'lost') ? n.status : 'error';
        const cls = st === 'stopped' ? 'badge warn' : 'badge danger';
        const border = st === 'stopped' ? 'var(--warning)' : 'var(--danger)';
        const logs = Array.isArray(n.logs) ? n.logs.map(x => String(x == null ? '' : x)) : [];
        return '<div class="card" style="margin-bottom:14px;border-color:' + border + ';">' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
              '<span class="' + cls + '">' + esc(Lang.t('stocks.state.' + st)) + '</span>' +
              '<span style="font-size:14px;flex:1 1 200px;min-width:0;">' + esc(Lang.t('stocks.status.' + st)) +
                (n.previous ? ' ' + esc(Lang.t('stocks.last_failed')) : '') + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-stk-act="dismiss">' + esc(Lang.t('stocks.close')) + '</button>' +
            '</div>' +
            (logs.length
                ? '<div class="console" style="max-height:200px;margin:10px 0 0;">' + esc(logs.join('\n')) + '</div>'
                : '') +
        '</div>';
    },

    // ------------------------------------------------------------- résultats

    _renderResults() {
        const host = this._el('stk-results');
        if (!host) return;
        const res = this._results;
        this._resultsShown = res;
        if (!res || typeof res !== 'object') { host.innerHTML = ''; return; }
        const rows = (Array.isArray(res.rows) ? res.rows : []).filter(x => x && typeof x === 'object');
        host.innerHTML = this._summaryHtml(res, rows) +
            this._resultWarningsHtml(res.warnings) +
            (rows.length
                ? '<div class="row-list" style="margin-bottom:14px;">' +
                  rows.map((row, i) => this._rowHtml(row, i, res)).join('') + '</div>'
                : this._emptyHtml());
    },

    _summaryHtml(res, rows) {
        const c = (res.counts && typeof res.counts === 'object') ? res.counts : {};
        const mono = this._MONO;
        const n = v => this._num(v, 0);
        const when = res.generated_at || this._ranAt;
        const source = res.source === 'fallback' ? Lang.t('stocks.source.fallback')
            : (res.source === 'screener' ? Lang.t('stocks.source.screener') : '');
        const funnel = this._tr('stocks.funnel', {
            universe: n(c.universe), shortlist: n(c.shortlist),
            kept: n(this._isNum(c.kept) ? c.kept : rows.length),
        });
        const excl = [];
        const add = (val, key) => { if (this._isNum(val) && Number(val) > 0) excl.push(this._tr(key, { n: n(val) })); };
        add(c.excluded_no_catalyst, 'stocks.excl.no_catalyst');
        add(c.excluded_red, 'stocks.excl.red');
        add(c.filtered_advice, 'stocks.excl.advice');
        add(c.dropped_irrelevant, 'stocks.excl.irrelevant');
        const mk = (Array.isArray(res.markets) ? res.markets : []).filter(m => m && typeof m === 'object');
        const chips = mk.map(m => {
            const label = this._marketLabel(m.id);
            if (m.ok === false) {
                return '<span class="badge danger" title="' + esc(this._plain(m.error)) + '">' +
                    esc(label + ' · ' + Lang.t('stocks.market_failed_short')) + '</span>';
            }
            const rowsTxt = this._isNum(m.rows) ? ' · ' + this._tr('stocks.market_rows', { n: n(m.rows) }) : '';
            return '<span class="badge muted">' + esc(label + rowsTxt) + '</span>';
        }).join('');
        return '<div class="card" style="margin-bottom:14px;">' +
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px;">' +
              '<h3 style="margin:0;font-size:17px;">' + esc(Lang.t('stocks.results_title')) + '</h3>' +
              (when ? '<span style="font-size:13px;color:var(--text-muted);' + mono + '">' +
                  esc(this._tr('stocks.generated_at', { date: this._dateTime(when) })) + '</span>' : '') +
            '</div>' +
            '<div style="font-size:14px;line-height:1.5;overflow-wrap:anywhere;">' + esc(funnel) + '</div>' +
            (source ? '<div style="font-size:13px;color:var(--text-muted);margin-top:4px;">' + esc(source) + '</div>' : '') +
            (excl.length
                ? '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;line-height:1.5;">' +
                  esc(Lang.t('stocks.excluded') + ' ' + excl.join(' · ')) + '</div>'
                : '') +
            (chips
                ? '<div style="margin-top:10px;">' +
                    '<div style="font-size:12px;color:var(--text-dim);margin-bottom:5px;">' + esc(Lang.t('stocks.markets_scanned')) + '</div>' +
                    '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + chips + '</div>' +
                  '</div>'
                : '') +
        '</div>';
    },

    _resultWarning(w) {
        const o = (w && typeof w === 'object') ? w : { code: String(w) };
        const code = String(o.code || '');
        const err = String(o.error == null ? '' : o.error);
        const vars = {
            columns: Array.isArray(o.columns) ? o.columns.map(String).join(', ') : this._plain(o.columns),
            market: o.market ? this._marketLabel(o.market) : '',
            error: err.length > 160 ? err.slice(0, 157) + '…' : err,
            code: code,
        };
        const key = 'stocks.rwarn.' + code;
        return (code && this._has(key)) ? this._tr(key, vars) : this._tr('stocks.warn.other', vars);
    },

    _resultWarningsHtml(list) {
        const w = Array.isArray(list) ? list : [];
        if (!w.length) return '';
        return '<div class="card" style="margin-bottom:14px;border-color:var(--warning);background:var(--bg-elev-2);">' +
            '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin-bottom:6px;">' +
              esc(Lang.t('stocks.warnings_title')) + '</div>' +
            '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;">' +
              w.map(x => '<li style="overflow-wrap:anywhere;">' + esc(this._resultWarning(x)) + '</li>').join('') +
            '</ul>' +
        '</div>';
    },

    _emptyHtml() {
        return '<div class="card" style="margin-bottom:14px;text-align:center;padding:24px;">' +
            '<div style="font-size:15px;">' + esc(Lang.t('stocks.empty')) + '</div>' +
            '<div style="font-size:13px;color:var(--text-muted);margin-top:6px;">' + esc(Lang.t('stocks.empty_hint')) + '</div>' +
        '</div>';
    },

    _flagHtml(code) {
        const c = String(code == null ? '' : code);
        if (!c) return '';
        const key = 'stocks.flag.' + c;
        const label = this._has(key) ? Lang.t(key) : c;
        const cls = c === 'red' ? 'badge danger'
            : ((c === 'late' || c === 'earnings_soon' || c === 'coach_down') ? 'badge warn' : 'badge muted');
        return '<span class="' + cls + '">' + esc(label) + '</span>';
    },

    _reasonText(r, res) {
        const o = (r && typeof r === 'object') ? r : { code: String(r) };
        const code = String(o.code || '');
        if (!code) return '';
        const key = 'stocks.reason.' + code;
        if (!this._has(key)) return code;
        let v = o.value;
        if (code === 'earnings') v = this._date(v);
        else if (code === 'volume') v = this._num(v, 1);
        else if (code === 'aligned') v = this._pct(v, 2, true);
        else if (code === 'news' || code === 'sources' || code === 'crowd') v = this._num(v, 0);
        else v = (v === null || v === undefined || typeof v === 'object') ? '' : String(v);
        let h = o.hours;
        if (!this._isNum(h) && res && res.config && typeof res.config === 'object') h = res.config.window_h;
        return this._tr(key, { v: v, h: this._isNum(h) ? this._num(h, 0) : '' });
    },

    _sentimentHtml(s) {
        const c = String(s == null ? '' : s);
        if (!c) return '';
        const key = 'stocks.sentiment.' + c;
        const label = this._has(key) ? Lang.t(key) : c;
        if (c === 'pos') return '<span class="badge" style="' + this._POS_BADGE + '">' + esc(label) + '</span>';
        const cls = c === 'neg' ? 'badge danger' : (c === 'watch' ? 'badge info' : 'badge muted');
        return '<span class="' + cls + '">' + esc(label) + '</span>';
    },

    _subHead(key) {
        return '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin:12px 0 4px;">' +
            esc(Lang.t(key)) + '</div>';
    },

    _newsHtml(items) {
        return items.map(it => {
            const url = this._safeUrl(it.url);
            const title = this._headline(it.title) || '—';
            const t = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                  'style="color:var(--text);text-decoration:none;border-bottom:1px dotted var(--border-strong);">' +
                  esc(title) + '</a>'
                : esc(title);
            const who = String(it.provider || it.source || '');
            const age = this._age(it.published);
            return '<div style="padding:8px 0;border-top:1px solid var(--border);">' +
                '<div style="font-size:14px;line-height:1.45;overflow-wrap:anywhere;">' + t + '</div>' +
                '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:3px;font-size:12px;color:var(--text-dim);">' +
                  (who ? '<span>' + esc(who) + '</span>' : '') +
                  (age ? '<span title="' + esc(this._dateTime(it.published)) + '">' + esc(age) + '</span>' : '') +
                  this._sentimentHtml(it.sentiment) +
                '</div>' +
            '</div>';
        }).join('');
    },

    _coachHtml(hyps, filings, reddit) {
        let out = '';
        if (hyps.length) {
            out += this._subHead('stocks.coach_title') + hyps.map(h => {
                const dir = h.direction === 'up'
                    ? '<span class="badge" style="' + this._POS_BADGE + '">' + esc(Lang.t('stocks.direction.up')) + '</span>'
                    : (h.direction === 'down'
                        ? '<span class="badge danger">' + esc(Lang.t('stocks.direction.down')) + '</span>' : '');
                const raw = (h.confidence === null || h.confidence === undefined) ? '' : String(h.confidence);
                const confKey = 'stocks.confidence.' + raw;
                const conf = raw ? this._tr('stocks.confidence', { v: this._has(confKey) ? Lang.t(confKey) : raw }) : '';
                return '<div style="padding:6px 0;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' + dir +
                    '<span style="font-size:14px;line-height:1.45;flex:1 1 200px;min-width:0;overflow-wrap:anywhere;">' +
                      esc(h.thesis || '—') + '</span>' +
                    (conf ? '<span style="font-size:12px;color:var(--text-dim);">' + esc(conf) + '</span>' : '') +
                '</div>';
            }).join('');
        }
        if (reddit) {
            out += '<div style="font-size:13px;color:var(--text-muted);padding:8px 0 2px;">' +
                esc(this._tr('stocks.reddit_line', { n: this._num(reddit.count, 0), prev: this._num(reddit.prev, 0) })) + '</div>';
        }
        if (filings.length) {
            out += this._subHead('stocks.filings_title') + filings.map(f => {
                const url = this._safeUrl(f.url);
                const label = [f.form, this._headline(f.title, 140)].filter(Boolean).map(String).join(' — ') || '—';
                const t = url
                    ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                      'style="color:var(--text);text-decoration:none;border-bottom:1px dotted var(--border-strong);">' +
                      esc(label) + '</a>'
                    : esc(label);
                return '<div style="padding:4px 0;font-size:13px;line-height:1.45;overflow-wrap:anywhere;">' + t + '</div>';
            }).join('');
        }
        return out;
    },

    _rowHtml(row, i, res) {
        const mono = this._MONO;
        const sym = row.symbol ? String(row.symbol) : '';
        const ticker = String(row.ticker || sym || row.tv_symbol || '—');
        const rank = this._isNum(row.rank) ? this._num(row.rank, 0) : String(i + 1);
        const score = this._isNum(row.score) ? this._tr('stocks.score', { n: this._num(row.score, 0) }) : '';

        // --- cours et variations ---
        const pr = Number(row.price);
        const price = this._isNum(row.price)
            ? this._num(pr, Math.abs(pr) < 1 ? 4 : 2) + (row.currency ? ' ' + String(row.currency) : '')
            : '—';
        const chgN = Number(row.change_pct);
        const chgColor = (!this._isNum(row.change_pct) || Number(chgN.toFixed(2)) === 0) ? 'var(--text-muted)'
            : (chgN > 0 ? 'var(--accent)' : 'var(--danger)');
        const nums = [];
        if (this._isNum(row.gap_pct)) nums.push(this._tr('stocks.gap', { v: this._pct(row.gap_pct, 2, true) }));
        if (this._isNum(row.rel_volume)) nums.push(this._tr('stocks.rel_volume', { v: this._num(row.rel_volume, 1) }));
        if (this._isNum(row.perf_w)) nums.push(this._tr('stocks.week', { v: this._pct(row.perf_w, 1, true) }));

        // --- place, secteur, taille, résultats à venir ---
        const meta = [];
        if (row.market) meta.push(this._marketLabel(row.market));
        if (row.exchange) meta.push(String(row.exchange));
        if (row.sector) meta.push(String(row.sector));
        if (this._isNum(row.market_cap_meur)) meta.push(this._tr('stocks.market_cap', { v: this._meur(row.market_cap_meur) }));
        if (this._isNum(row.avg_value_meur)) meta.push(this._tr('stocks.avg_value', { v: this._meur(row.avg_value_meur) }));
        if (row.earnings_next && this._date(row.earnings_next) !== '—') {
            meta.push(this._tr('stocks.earnings_next', { date: this._date(row.earnings_next) }));
        }

        const flags = (Array.isArray(row.flags) ? row.flags : []).map(f => this._flagHtml(f)).join('');
        const reasons = (Array.isArray(row.reasons) ? row.reasons : [])
            .map(r => this._reasonText(r, res)).filter(Boolean)
            .map(txt => '<span style="' + this._CHIP + '">' + esc(txt) + '</span>').join('');

        // --- actions ---
        const chartUrl = this._safeUrl(row.links && typeof row.links === 'object' ? row.links.chart : '') ||
            (row.tv_symbol ? 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(String(row.tv_symbol)) : '');
        const chart = chartUrl
            ? '<a class="btn btn-ghost btn-sm" href="' + esc(chartUrl) + '" target="_blank" rel="noopener noreferrer">' +
              esc(Lang.t('stocks.chart')) + '</a>'
            : '';
        const followed = !!(sym && this._followed && this._followed[sym]);
        const follow = sym
            ? '<button class="btn btn-secondary btn-sm" data-stk-follow="' + esc(sym) + '"' +
              (followed ? ' disabled style="opacity:.7;cursor:default;"' : '') + '>' +
              esc(Lang.t(followed ? 'stocks.following' : 'stocks.follow')) + '</button>'
            : '';

        // --- news et coach, dépliables ---
        const news = (Array.isArray(row.news) ? row.news : []).filter(x => x && typeof x === 'object');
        const coach = (row.coach && typeof row.coach === 'object') ? row.coach : {};
        const hyps = (Array.isArray(coach.hypotheses) ? coach.hypotheses : []).filter(x => x && typeof x === 'object');
        const filings = (Array.isArray(coach.filings) ? coach.filings : []).filter(x => x && typeof x === 'object');
        const reddit = (coach.reddit && typeof coach.reddit === 'object' && this._isNum(coach.reddit.count)) ? coach.reddit : null;
        const parts = [];
        if (news.length) parts.push(this._tr('stocks.details_news', { n: news.length }));
        if (hyps.length) parts.push(this._tr('stocks.details_coach', { n: hyps.length }));
        if (filings.length) parts.push(this._tr('stocks.details_sec', { n: filings.length }));
        const detailBody = (news.length ? this._newsHtml(news) : '') + this._coachHtml(hyps, filings, reddit);
        const details = detailBody
            ? '<details style="margin-top:10px;">' +
                '<summary style="cursor:pointer;font-size:13px;color:var(--text-muted);padding:2px 0;">' +
                  esc(parts.length ? parts.join(' · ') : Lang.t('stocks.details')) + '</summary>' +
                '<div style="margin-top:6px;">' + detailBody + '</div>' +
              '</details>'
            : '';

        // display:block explicite : `.row` du design system est une grille à
        // quatre colonnes, tout enfant de plus s'y rangerait en colonne.
        return '<div class="row" style="display:block;padding:12px 14px;">' +
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
              '<span style="' + mono + 'color:var(--text-dim);font-size:13px;">#' + esc(rank) + '</span>' +
              '<span style="' + mono + 'font-size:16px;font-weight:600;overflow-wrap:anywhere;">' + esc(ticker) + '</span>' +
              '<span style="font-size:15px;flex:1 1 140px;min-width:0;overflow-wrap:anywhere;">' + esc(row.name || '') + '</span>' +
              (score ? '<span class="badge" style="' + mono + 'color:var(--text);font-weight:600;">' + esc(score) + '</span>' : '') +
            '</div>' +
            '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:baseline;margin-top:6px;' + mono + '">' +
              '<span style="font-size:15px;">' + esc(price) + '</span>' +
              '<span style="font-size:15px;color:' + chgColor + ';">' + esc(this._pct(row.change_pct, 2, true)) + '</span>' +
              nums.map(x => '<span style="font-size:13px;color:var(--text-muted);">' + esc(x) + '</span>').join('') +
            '</div>' +
            (meta.length
                ? '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;line-height:1.5;overflow-wrap:anywhere;">' +
                  esc(meta.join(' · ')) + '</div>'
                : '') +
            (flags ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' + flags + '</div>' : '') +
            (reasons ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">' + reasons + '</div>' : '') +
            ((chart || follow) ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' + chart + follow + '</div>' : '') +
            details +
        '</div>';
    },

    // ------------------------------------------------------------- actions

    // « Suivre dans le simulateur » : le titre entre dans les favoris du Paper
    // Trading, donc dans la veille du coach (spec §9).
    async follow(btn) {
        const sym = btn.getAttribute('data-stk-follow');
        if (!sym || btn.disabled) return;
        btn.disabled = true;
        const gen = this._gen;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/watchlist', { method: 'POST', body: JSON.stringify({ symbol: sym }) });
        } catch (e) { r = null; }
        if (gen !== this._gen) return;
        if (r && r.ok) {
            if (!this._followed) this._followed = Object.create(null);
            this._followed[sym] = true;
            if (this._container) {
                this._container.querySelectorAll('[data-stk-follow]').forEach(b => {
                    if (b.getAttribute('data-stk-follow') !== sym) return;
                    b.disabled = true;
                    b.textContent = Lang.t('stocks.following');
                    b.style.opacity = '.7';
                    b.style.cursor = 'default';
                });
            }
            if (typeof Toast !== 'undefined' && Toast.success) Toast.success(this._tr('stocks.follow_ok', { symbol: sym }));
            return;
        }
        btn.disabled = false;
        if (!r) return;                                  // 401 / réseau : Auth a déjà prévenu
        const d = await this._json(r);
        if (gen !== this._gen) return;
        const detail = (d && typeof d.detail === 'string') ? d.detail : '';
        let msg;
        if (r.status === 400) msg = Lang.t('stocks.follow_full');
        else if (r.status === 404) msg = this._tr('stocks.follow_unknown', { symbol: sym });
        else if (r.status === 502) msg = Lang.t('stocks.follow_quote');
        else msg = Lang.t('stocks.follow_error') + (detail ? ' (' + detail + ')' : '');
        if (typeof Toast !== 'undefined' && Toast.error) Toast.error(msg);
    },

    async download() {
        const job = this._resultsJob;
        if (!job) return;
        const btn = this._el('stk-dl-btn');
        if (btn) btn.disabled = true;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/stocks/download/' + encodeURIComponent(job)); } catch (e) { r = null; }
        if (btn) btn.disabled = false;
        if (!r) return;                                  // 401 / réseau : Auth a déjà prévenu
        if (!r.ok) {
            if (typeof Toast !== 'undefined' && Toast.error) Toast.error(Lang.t('stocks.download_error'));
            return;
        }
        let blob = null;
        try { blob = await r.blob(); } catch (e) { blob = null; }
        if (!blob) {
            if (typeof Toast !== 'undefined' && Toast.error) Toast.error(Lang.t('stocks.download_error'));
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this._fileName(r, job);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    // Nom du classeur : celui du serveur (Content-Disposition), sinon celui
    // appris de /status, sinon stocks-<job>.xlsx.
    _fileName(r, job) {
        let name = '';
        try {
            const cd = (r.headers && r.headers.get('Content-Disposition')) || '';
            let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
            if (m) name = decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''));
            else {
                m = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
                if (m) name = m[1].trim();
            }
        } catch (e) { name = ''; }
        if (!name && this._excel && this._excel.job === job && this._excel.name) name = this._excel.name;
        name = String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]+/g, '_').trim();
        if (!name || !/\.xlsx$/i.test(name)) name = 'stocks-' + String(job).slice(0, 8) + '.xlsx';
        return name;
    },
};
