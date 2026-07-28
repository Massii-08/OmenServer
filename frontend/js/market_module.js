// frontend/js/market_module.js
// Vue dédiée Market Pulse : horloge des marchés, gaps d'ouverture, rapport du
// jour, statistiques historiques, notices de presse, planification matinale.
//
// Lecture seule côté données : tout vient de /api/bots/market/snapshot (le
// dernier run du moteur `market-pulse/`). Le lancement/arrêt et la planification
// sont admin-only (le backend garde aussi la porte).
//
// Contraintes du dépôt respectées ici :
//   - vanilla JS, zéro dépendance, zéro CSS externe (composants Bento + style inline minimal) ;
//   - toute donnée dynamique passe par esc() avant innerHTML (audit sécurité 2026-06-21) ;
//   - tout texte d'interface passe par Lang.t() (le CONTENU reste italien, il vient du backend) ;
//   - appels API uniquement via Auth.apiCall().
//
// Lecture destinée à un investisseur particulier italien âgé : nombres au format
// italien (51.698,19 / +0,41%), taux en points de base, aucune recommandation.
const MarketModule = {
    _container: null,
    _refreshInterval: null,   // rafraîchit le snapshot (horloge) toutes les 60 s
    _pollInterval: null,      // suit un run en cours (statut) toutes les 3 s
    _jobId: null,
    _running: false,
    _data: null,
    _statsOpen: false,        // survit aux rafraîchissements du corps

    // ------------------------------------------------------------- cycle de vie

    async render(container) {
        this.unload();                       // coupe tout timer d'un rendu précédent
        this._container = container;
        container.innerHTML = this._shell();
        await this._loadActive();            // un run tourne déjà ?
        await this._loadSnapshot();
        if (this._isAdmin()) this._loadSchedule();
        this._refreshInterval = setInterval(() => this._loadSnapshot(), 60000);
    },

    unload() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
        if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
    },

    _isAdmin() {
        try {
            const u = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
            return !!(u && u.is_admin);
        } catch (e) { return false; }
    },

    // ------------------------------------------------------------- formatage IT

    // 51698.19 -> "51.698,19" (milliers ".", décimale ",")
    _fmt(v, dec) {
        const n = Number(v);
        if (v === null || v === undefined || v === '' || !isFinite(n)) return '—';
        const d = (dec === null || dec === undefined) ? 2 : dec;
        const parts = Math.abs(n).toFixed(d).split('.');
        const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return (n < 0 ? '-' : '') + int + (parts[1] ? ',' + parts[1] : '');
    },

    // signe explicite : "+0,41%" / "-3,95%" / "-5 pb"
    _fmtSigned(v, dec, unit) {
        const n = Number(v);
        if (v === null || v === undefined || v === '' || !isFinite(n)) return '—';
        return (n > 0 ? '+' : '') + this._fmt(n, dec) + (unit || '');
    },

    // "2026-07-28" -> "28/07/2026"
    _date(iso) {
        const m = String(iso == null ? '' : iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? (m[3] + '/' + m[2] + '/' + m[1]) : '—';
    },

    // epoch (s) -> "28/07/2026 14:05" dans le fuseau du navigateur
    _dateTime(ts) {
        const n = Number(ts);
        if (!ts || !isFinite(n)) return '—';
        const d = new Date(n * 1000);
        if (isNaN(d.getTime())) return '—';
        const p = x => (x < 10 ? '0' : '') + x;
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
            ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    _color(dir) {
        if (dir > 0) return 'var(--accent)';
        if (dir < 0) return 'var(--danger)';
        return 'var(--text-muted)';
    },

    // Le "prix" d'un taux EST un taux (4,59%) ; une paire de devises se lit à 4 décimales.
    _price(m) {
        if (m.price === null || m.price === undefined) return '—';
        if (m.kind === 'rate') return this._fmt(m.price, 2) + '%';
        if (m.kind === 'fx') return this._fmt(m.price, 4);
        return this._fmt(m.price, 2);
    },

    // Variation : en points de base pour un taux (dire "-1,06%" d'un rendement
    // qui passe de 4,64 à 4,59 est trompeur), en pourcentage sinon.
    _change(m) {
        if (m.kind === 'rate' && m.price !== null && m.price !== undefined &&
            m.prev_close !== null && m.prev_close !== undefined) {
            const bp = Math.round((Number(m.price) - Number(m.prev_close)) * 100);
            if (!isFinite(bp)) return { txt: '—', dir: 0 };
            return { txt: this._fmtSigned(bp, 0, ' pb'), dir: bp };
        }
        if (m.change_pct === null || m.change_pct === undefined) return { txt: '—', dir: 0 };
        const n = Number(m.change_pct);
        if (!isFinite(n)) return { txt: '—', dir: 0 };
        return { txt: this._fmtSigned(n, 2, '%'), dir: n };
    },

    // Même logique pour le gap d'ouverture.
    _gap(m) {
        const g = m.gap;
        if (!g) return null;
        if (m.kind === 'rate' && g.open !== null && g.open !== undefined &&
            g.prev_close !== null && g.prev_close !== undefined) {
            const bp = Math.round((Number(g.open) - Number(g.prev_close)) * 100);
            if (!isFinite(bp)) return null;
            return { txt: this._fmtSigned(bp, 0, ' pb'), dir: bp };
        }
        if (g.gap_pct === null || g.gap_pct === undefined) return null;
        const n = Number(g.gap_pct);
        if (!isFinite(n)) return null;
        return { txt: this._fmtSigned(n, 2, '%'), dir: n };
    },

    _safeUrl(u) {
        const s = String(u == null ? '' : u);
        return /^https?:\/\//i.test(s) ? s : '';
    },

    // ------------------------------------------------------------- coquille

    _shell() {
        const admin = this._isAdmin();
        const runBtn = admin
            ? '<button class="btn btn-primary" id="mkt-run-btn" onclick="MarketModule.start()">' +
              esc(Lang.t('market.run')) + '</button>' +
              '<button class="btn btn-danger" id="mkt-stop-btn" style="display:none;" onclick="MarketModule.stop()">' +
              esc(Lang.t('market.stop')) + '</button>'
            : '';
        return '' +
        '<div class="card" style="margin-bottom:14px;">' +
          '<div class="b-head" style="margin-bottom:10px;">' +
            '<span class="b-icon b-ticker">MKT</span>' +
            '<div class="b-name-wrap">' +
              '<div class="b-name">' + esc(Lang.t('market.title')) + '</div>' +
              '<div class="b-type">' + esc(Lang.t('market.subtitle')) + '</div>' +
            '</div>' +
            '<span class="badge" id="mkt-status" style="margin-left:auto;"></span>' +
          '</div>' +
          '<div class="b-desc" style="margin-bottom:10px;">' + esc(Lang.t('market.desc')) + '</div>' +
          '<div id="mkt-lastrun" style="font-size:13px;color:var(--text-muted);font-family:var(--font-mono);' +
               'font-feature-settings:\'tnum\';margin-bottom:12px;">' +
            esc(Lang.t('market.never_run')) +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            runBtn +
            '<button class="btn btn-ghost" onclick="MarketModule.refresh()">' + esc(Lang.t('market.refresh')) + '</button>' +
            '<button class="btn btn-ghost" id="mkt-dl-xlsx" style="display:none;" onclick="MarketModule.downloadExcel()">' +
              esc(Lang.t('market.download_excel')) + '</button>' +
            '<button class="btn btn-ghost" id="mkt-dl-report" style="display:none;" onclick="MarketModule.downloadReport()">' +
              esc(Lang.t('market.download_report')) + '</button>' +
            '<button class="btn btn-ghost" onclick="MarketModule.back()">' + esc(Lang.t('market.back')) + '</button>' +
          '</div>' +
        '</div>' +
        // Rappel « faits seulement » : visible juste sous l'en-tête, pas noyé en bas.
        '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
             'background:var(--bg-elev-2);font-size:14px;line-height:1.5;">' +
          esc(Lang.t('market.disclaimer')) +
        '</div>' +
        '<div id="mkt-schedule"></div>' +
        '<div id="mkt-body"><div class="card">' + esc(Lang.t('market.loading')) + '</div></div>';
    },

    // ------------------------------------------------------------- chargement

    // Le backend peut renvoyer soit le snapshot brut ({markets, errors,…}),
    // soit une enveloppe {snapshot, report, stats, news, generated_at}.
    // On accepte les deux et on ne suppose jamais qu'un champ existe.
    _normalize(d) {
        const raw = (d && typeof d === 'object') ? d : {};
        const snap = (raw.snapshot && typeof raw.snapshot === 'object') ? raw.snapshot : raw;
        let report = raw.report;
        if (report && typeof report === 'object') report = report.text || report.report || '';
        let stats = raw.stats;
        if (stats && typeof stats === 'object' && stats.stats && typeof stats.stats === 'object') stats = stats.stats;
        if (!stats || typeof stats !== 'object' || Array.isArray(stats)) stats = {};
        return {
            markets: Array.isArray(snap.markets) ? snap.markets : [],
            errors: Array.isArray(snap.errors) ? snap.errors : [],
            report: (typeof report === 'string') ? report : '',
            stats: stats,
            news: raw.news || null,
            generated_at: raw.generated_at || snap.generated_at || null,
            job_id: raw.job_id || null,
        };
    },

    async _loadSnapshot() {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/snapshot'); } catch (e) { r = null; }
        const body = document.getElementById('mkt-body');
        if (!body) return;                                    // module déchargé entre-temps
        if (!r) return;                                       // 401 déjà géré par Auth.apiCall
        if (r.status === 404) { body.innerHTML = this._empty(Lang.t('market.no_data')); return; }
        if (!r.ok) { body.innerHTML = this._empty(Lang.t('market.error') + ' (' + r.status + ')'); return; }
        let d = null;
        try { d = await r.json(); } catch (e) { body.innerHTML = this._empty(Lang.t('market.error')); return; }
        this._data = this._normalize(d);
        if (this._data.job_id && !this._jobId) this._jobId = this._data.job_id;
        if (!this._data.markets.length) { body.innerHTML = this._empty(Lang.t('market.no_data')); }
        else { body.innerHTML = this._page(this._data); }
        this._paintHeader();
    },

    async _loadActive() {
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/active'); } catch (e) { r = null; }
        if (!r || !r.ok) return;
        let d = null;
        try { d = await r.json(); } catch (e) { return; }
        if (d && d.job_id) {
            this._jobId = d.job_id;
            this._running = (d.status === 'running' || d.status === undefined);
            if (this._running) this._startPolling();
            this._paintHeader();
        }
    },

    _empty(msg) {
        return '<div class="card" style="text-align:center;color:var(--text-muted);padding:24px;">' +
            esc(msg) + '</div>';
    },

    _paintHeader() {
        const st = document.getElementById('mkt-status');
        if (st) {
            st.textContent = this._running ? Lang.t('market.running') : '';
            st.className = 'badge' + (this._running ? ' online' : '');
        }
        const last = document.getElementById('mkt-lastrun');
        if (last) {
            const ts = this._data ? this._data.generated_at : null;
            last.textContent = ts
                ? (Lang.t('market.last_run') + ' ' + this._dateTime(ts))
                : Lang.t('market.never_run');
        }
        const runBtn = document.getElementById('mkt-run-btn');
        if (runBtn) { runBtn.disabled = !!this._running; runBtn.style.display = this._running ? 'none' : ''; }
        const stopBtn = document.getElementById('mkt-stop-btn');
        if (stopBtn) stopBtn.style.display = this._running ? '' : 'none';
        const xlsx = document.getElementById('mkt-dl-xlsx');
        if (xlsx) xlsx.style.display = this._jobId ? '' : 'none';
        const rep = document.getElementById('mkt-dl-report');
        if (rep) rep.style.display = this._jobId ? '' : 'none';
    },

    // ------------------------------------------------------------- corps

    _page(d) {
        return [
            this._clockSection(d.markets),
            this._gapsSection(d.markets),
            this._reportSection(d.report),
            this._newsSection(d.news),
            this._statsSection(d.stats, d.markets),
            this._errorsSection(d.errors),
        ].join('');
    },

    _sectionHead(title, note) {
        return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<h3 style="margin:0;font-size:17px;">' + esc(title) + '</h3>' +
            (note ? '<span style="font-size:12px;color:var(--text-dim);">' + esc(note) + '</span>' : '') +
        '</div>';
    },

    // --- 1. Horloge des marchés, groupée par zone ---------------------------

    _clockSection(markets) {
        const regions = [
            ['europe', 'market.region_europe'],
            ['usa', 'market.region_usa'],
            ['asia', 'market.region_asia'],
            ['global', 'market.region_global'],
        ];
        const seen = {};
        let blocks = '';
        regions.forEach(pair => {
            const rows = markets.filter(m => m && m.region === pair[0]);
            rows.forEach(m => { seen[m.symbol] = true; });
            if (!rows.length) return;
            blocks += this._regionBlock(Lang.t(pair[1]), rows);
        });
        // Une zone inconnue du backend ne doit pas faire disparaître ses marchés.
        const rest = markets.filter(m => m && !seen[m.symbol]);
        if (rest.length) blocks += this._regionBlock(Lang.t('market.region_global'), rest);
        return '<div class="card" style="margin-bottom:14px;">' +
            this._sectionHead(Lang.t('market.clock_title')) + blocks + '</div>';
    },

    _regionBlock(title, rows) {
        return '<div style="margin-bottom:14px;">' +
            '<div style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);' +
                 'margin-bottom:6px;">' + esc(title) + '</div>' +
            '<div class="row-list">' + rows.map(m => this._clockRow(m)).join('') + '</div>' +
        '</div>';
    },

    _clockRow(m) {
        const clock = (m && m.clock) ? m.clock : {};
        const status = clock.status || 'unknown';
        const badgeCls = status === 'open' ? 'badge online' : 'badge';
        const badgeTxt = status === 'open' ? Lang.t('market.status_open')
            : (status === 'closed' ? Lang.t('market.status_closed') : Lang.t('market.status_unknown'));
        const ch = this._change(m);
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        // Prochaine bascule : on affiche l'heure de séance dans le fuseau de la
        // place (même référentiel que local_time) — jamais un mélange de fuseaux.
        let next = '';
        if (status === 'open' && clock.session_close) {
            next = Lang.t('market.closes_at') + ' ' + clock.session_close;
        } else if (status !== 'open' && clock.session_open) {
            next = Lang.t('market.opens_at') + ' ' + clock.session_open;
        }
        const hours = (clock.session_open && clock.session_close)
            ? (Lang.t('market.session_hours') + ' ' + clock.session_open + '–' + clock.session_close) : '';
        const localT = clock.local_time
            ? (Lang.t('market.local_time') + ' ' + clock.local_time + (clock.tz_name ? ' (' + clock.tz_name + ')' : ''))
            : '';
        return '<div class="row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;">' +
            '<div style="flex:1 1 190px;min-width:0;">' +
              '<div style="font-size:16px;font-weight:600;">' + esc(m.label || m.name || m.symbol || '') + '</div>' +
              '<div style="font-size:12px;color:var(--text-dim);' + mono + '">' + esc(m.symbol || '') +
                (m.currency ? ' · ' + esc(m.currency) : '') + '</div>' +
            '</div>' +
            '<div style="min-width:130px;text-align:right;' + mono + '">' +
              '<div style="font-size:17px;">' + esc(this._price(m)) + '</div>' +
              '<div style="font-size:14px;color:' + this._color(ch.dir) + ';">' + esc(ch.txt) + '</div>' +
            '</div>' +
            '<div style="min-width:200px;display:flex;flex-direction:column;align-items:flex-end;gap:3px;">' +
              '<span class="' + badgeCls + '">' + esc(badgeTxt) + '</span>' +
              (next ? '<span style="font-size:13px;' + mono + '">' + esc(next) + '</span>' : '') +
              (localT ? '<span style="font-size:12px;color:var(--text-muted);' + mono + '">' + esc(localT) + '</span>' : '') +
              (hours ? '<span style="font-size:12px;color:var(--text-dim);' + mono + '">' + esc(hours) + '</span>' : '') +
            '</div>' +
        '</div>';
    },

    // --- 2. Gaps d'ouverture ----------------------------------------------

    _gapsSection(markets) {
        const withGap = markets.filter(m => m && m.gap && this._gap(m));
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        if (!withGap.length) {
            return '<div class="card" style="margin-bottom:14px;">' +
                this._sectionHead(Lang.t('market.gaps_title')) +
                '<div style="color:var(--text-muted);">' + esc(Lang.t('market.no_data')) + '</div></div>';
        }
        // Les gaps du jour d'abord, puis les plus anciens : le lecteur voit
        // immédiatement ce qui s'est passé ce matin.
        const today = withGap.filter(m => m.gap_is_today);
        const older = withGap.filter(m => !m.gap_is_today);
        const rows = today.concat(older).map(m => {
            const g = this._gap(m);
            const isToday = !!m.gap_is_today;
            const tag = isToday ? Lang.t('market.gap_today') : Lang.t('market.gap_last');
            return '<div class="row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;' +
                (isToday ? '' : 'opacity:.72;') + '">' +
                '<div style="flex:1 1 190px;min-width:0;">' +
                  '<div style="font-size:16px;font-weight:600;">' + esc(m.label || m.symbol || '') + '</div>' +
                  '<div style="font-size:12px;color:var(--text-dim);' + mono + '">' +
                    esc(tag) + ' ' + esc(this._date(m.gap.date)) +
                    ' · ' + esc(Lang.t('market.prev_close')) + ' ' + esc(this._date(m.gap.prev_date)) +
                  '</div>' +
                '</div>' +
                '<div style="min-width:120px;text-align:right;' + mono + '">' +
                  '<div style="font-size:19px;font-weight:600;color:' + this._color(g.dir) + ';">' + esc(g.txt) + '</div>' +
                '</div>' +
                '<div style="min-width:150px;text-align:right;font-size:12px;color:var(--text-muted);' + mono + '">' +
                  esc(Lang.t('market.price')) + ' ' + esc(this._fmt(m.gap.open, m.kind === 'fx' ? 4 : 2)) +
                  ' · ' + esc(Lang.t('market.prev_close')) + ' ' + esc(this._fmt(m.gap.prev_close, m.kind === 'fx' ? 4 : 2)) +
                '</div>' +
            '</div>';
        }).join('');
        return '<div class="card" style="margin-bottom:14px;">' +
            this._sectionHead(Lang.t('market.gaps_title')) +
            '<div class="row-list">' + rows + '</div></div>';
    },

    // --- 3. Rapport du jour ------------------------------------------------

    _reportSection(report) {
        if (!report) return '';
        return '<div class="card" style="margin-bottom:14px;">' +
            this._sectionHead(Lang.t('market.report_title')) +
            '<pre style="margin:0;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;' +
                 'font-family:var(--font-mono);font-size:14px;line-height:1.6;background:var(--bg-elev-3);' +
                 'padding:14px;border-radius:var(--r-md);">' + esc(report) + '</pre>' +
        '</div>';
    },

    // --- 4. Notices / presse (facultatif : news peut être null) -------------

    _newsSection(news) {
        if (!news) return '';
        const items = Array.isArray(news) ? news
            : (Array.isArray(news.items) ? news.items
            : (Array.isArray(news.headlines) ? news.headlines : []));
        const themes = (news && Array.isArray(news.themes)) ? news.themes
            : ((news && Array.isArray(news.mentions)) ? news.mentions : []);
        const sources = (news && Array.isArray(news.sources)) ? news.sources : [];
        if (!items.length && !themes.length && !sources.length) return '';

        const itemRows = items.slice(0, 25).map(it => {
            const o = (it && typeof it === 'object') ? it : { title: it };
            const title = o.title || o.headline || o.text || '';
            const src = o.source || o.feed || o.site || '';
            const url = this._safeUrl(o.url || o.link);
            const when = o.published || o.date || o.ts_iso || '';
            const head = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                  'style="color:var(--text);text-decoration:none;">' + esc(title) + '</a>'
                : esc(title);
            const meta = [src, when].filter(Boolean).map(x => esc(String(x))).join(' · ');
            return '<div class="row" style="padding:9px 12px;">' +
                '<div style="font-size:15px;line-height:1.4;">' + head + '</div>' +
                (meta ? '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">' + meta + '</div>' : '') +
            '</div>';
        }).join('');

        const themeRows = themes.slice(0, 20).map(t => {
            let label = '', count = null;
            if (Array.isArray(t)) { label = t[0]; count = t[1]; }
            else if (t && typeof t === 'object') {
                label = t.theme || t.term || t.keyword || t.name || t.label || '';
                count = (t.count !== undefined) ? t.count : (t.mentions !== undefined ? t.mentions : t.n);
            } else { label = t; }
            if (!label) return '';
            const c = (count === null || count === undefined) ? '' : String(count);
            return '<span class="badge" style="margin:0 6px 6px 0;">' + esc(label) +
                (c ? ' · ' + esc(c) : '') + '</span>';
        }).join('');

        const srcRow = sources.map(s => {
            const label = (s && typeof s === 'object') ? (s.name || s.source || s.url || '') : s;
            return label ? '<span class="badge" style="margin:0 6px 6px 0;">' + esc(label) + '</span>' : '';
        }).join('');

        return '<div class="card" style="margin-bottom:14px;">' +
            this._sectionHead(Lang.t('market.news_title')) +
            (itemRows ? '<div class="row-list" style="margin-bottom:10px;">' + itemRows + '</div>' : '') +
            (themeRows
                ? '<div style="margin-bottom:8px;"><div style="font-size:12px;color:var(--text-dim);margin-bottom:5px;">' +
                  esc(Lang.t('market.theme')) + ' · ' + esc(Lang.t('market.mentions')) + '</div>' + themeRows + '</div>'
                : '') +
            (srcRow
                ? '<div><div style="font-size:12px;color:var(--text-dim);margin-bottom:5px;">' +
                  esc(Lang.t('market.news_sources')) + '</div>' + srcRow + '</div>'
                : '') +
        '</div>';
    },

    // --- 5. Statistiques historiques (repliable, fermé par défaut) ----------

    _statsSection(stats, markets) {
        const symbols = Object.keys(stats || {});
        if (!symbols.length) return '';
        // On suit l'ordre des marchés (Europe → USA → Asie → global) quand on
        // le connaît, puis on ajoute le reste.
        const ordered = [];
        markets.forEach(m => { if (m && stats[m.symbol] && ordered.indexOf(m.symbol) < 0) ordered.push(m.symbol); });
        symbols.forEach(s => { if (ordered.indexOf(s) < 0) ordered.push(s); });
        const blocks = ordered.map(sym => this._statsBlock(sym, stats[sym])).join('');
        return '<div class="card" style="margin-bottom:14px;">' +
            '<details ' + (this._statsOpen ? 'open ' : '') + 'ontoggle="MarketModule._statsOpen=this.open">' +
              '<summary style="cursor:pointer;font-size:17px;font-weight:600;padding:2px 0;">' +
                esc(Lang.t('market.stats_title')) + '</summary>' +
              '<div style="margin-top:12px;">' + blocks + '</div>' +
            '</details>' +
        '</div>';
    },

    _statsBlock(symbol, st) {
        if (!st || typeof st !== 'object') return '';
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        const th = 'text-align:left;padding:5px 10px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-dim);font-weight:500;';
        const td = 'padding:5px 10px;border-bottom:1px solid var(--border);font-size:14px;';
        const wd = (st.weekday_stats && typeof st.weekday_stats === 'object') ? st.weekday_stats : {};
        const days = Object.keys(wd);
        const rows = days.map(day => {
            const s = wd[day] || {};
            const avg = Number(s.avg_gap_pct);
            return '<tr>' +
                '<td style="' + td + '">' + esc(day) + '</td>' +
                '<td style="' + td + mono + '">' + esc(this._fmt(s.n, 0)) + '</td>' +
                '<td style="' + td + mono + 'color:' + this._color(isFinite(avg) ? avg : 0) + ';">' +
                  esc(this._fmtSigned(s.avg_gap_pct, 2, '%')) + '</td>' +
                '<td style="' + td + mono + '">' + esc(this._fmt(s.pct_up, 1)) + '%</td>' +
            '</tr>';
        }).join('');
        const table = days.length
            ? '<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;min-width:340px;">' +
                '<thead><tr>' +
                  '<th style="' + th + '">' + esc(Lang.t('market.weekday')) + '</th>' +
                  '<th style="' + th + '">' + esc(Lang.t('market.sessions')) + '</th>' +
                  '<th style="' + th + '">' + esc(Lang.t('market.avg_gap')) + '</th>' +
                  '<th style="' + th + '">' + esc(Lang.t('market.pct_up')) + '</th>' +
                '</tr></thead><tbody>' + rows + '</tbody></table></div>'
            : '';
        const gaps = Array.isArray(st.biggest_gaps) ? st.biggest_gaps.slice(0, 5) : [];
        const gapRow = gaps.length
            ? '<div style="margin-top:8px;font-size:12px;color:var(--text-dim);">' + esc(Lang.t('market.biggest_gaps')) + '</div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;">' +
              gaps.map(g => {
                  const n = Number(g && g.gap_pct);
                  return '<span class="badge" style="' + mono + 'color:' + this._color(isFinite(n) ? n : 0) + ';">' +
                      esc(this._date(g && g.date)) + ' ' + esc(this._fmtSigned(g && g.gap_pct, 2, '%')) + '</span>';
              }).join('') +
              '</div>'
            : '';
        const nSess = (st.n_sessions === null || st.n_sessions === undefined)
            ? '' : (Lang.t('market.sessions') + ' ' + this._fmt(st.n_sessions, 0));
        return '<div style="margin-bottom:16px;">' +
            '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px;">' +
              '<span style="font-size:15px;font-weight:600;">' + esc(st.label || symbol) + '</span>' +
              '<span style="font-size:12px;color:var(--text-dim);' + mono + '">' + esc(symbol) +
                (nSess ? ' · ' + esc(nSess) : '') + '</span>' +
            '</div>' + table + gapRow +
        '</div>';
    },

    // --- 6. Erreurs du relevé (honnêteté : dire ce qui manque) --------------

    _errorsSection(errors) {
        if (!errors || !errors.length) return '';
        const rows = errors.map(e => {
            const o = (e && typeof e === 'object') ? e : { error: e };
            return '<div class="row" style="padding:8px 12px;font-size:13px;">' +
                '<span style="font-family:var(--font-mono);color:var(--text-muted);">' + esc(o.symbol || '') + '</span>' +
                (o.symbol ? ' · ' : '') + '<span style="color:var(--danger);">' + esc(o.error || '') + '</span>' +
            '</div>';
        }).join('');
        return '<div class="card" style="margin-bottom:14px;border-color:var(--danger);">' +
            this._sectionHead(Lang.t('market.errors_title')) +
            '<div class="row-list">' + rows + '</div></div>';
    },

    // ------------------------------------------------------------- planification

    async _loadSchedule() {
        const host = document.getElementById('mkt-schedule');
        if (!host) return;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/schedule'); } catch (e) { r = null; }
        if (!r || !r.ok) { host.innerHTML = ''; return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        host.innerHTML = this._scheduleForm(d || {});
    },

    _scheduleForm(s) {
        const enabled = !!s.enabled;
        const time = /^\d{2}:\d{2}$/.test(String(s.time || '')) ? s.time : '07:30';
        const days = (s.days === 'daily') ? 'daily' : 'weekdays';
        return '<div class="card" style="margin-bottom:14px;">' +
            this._sectionHead(Lang.t('market.schedule_title')) +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;margin-bottom:10px;">' +
              '<input type="checkbox" id="mkt-sch-enabled"' + (enabled ? ' checked' : '') +
                ' style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />' +
              '<span>' + esc(Lang.t('market.schedule_enabled')) + '</span>' +
            '</label>' +
            '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">' +
              '<div style="flex:0 1 140px;">' +
                '<label class="form-label">' + esc(Lang.t('market.schedule_time')) + '</label>' +
                '<input id="mkt-sch-time" class="form-input" type="time" value="' + esc(time) + '" />' +
              '</div>' +
              '<div style="flex:0 1 200px;">' +
                '<label class="form-label">' + esc(Lang.t('market.schedule_days')) + '</label>' +
                '<select id="mkt-sch-days" class="form-input">' +
                  '<option value="weekdays"' + (days === 'weekdays' ? ' selected' : '') + '>' +
                    esc(Lang.t('market.schedule_weekdays')) + '</option>' +
                  '<option value="daily"' + (days === 'daily' ? ' selected' : '') + '>' +
                    esc(Lang.t('market.schedule_daily')) + '</option>' +
                '</select>' +
              '</div>' +
              '<button class="btn btn-primary" onclick="MarketModule.saveSchedule()">' +
                esc(Lang.t('market.schedule_save')) + '</button>' +
              '<span id="mkt-sch-msg" style="font-size:12px;color:var(--text-dim);"></span>' +
            '</div>' +
            (enabled ? '' : '<div class="form-hint">' + esc(Lang.t('market.schedule_off')) + '</div>') +
        '</div>';
    },

    async saveSchedule() {
        const el = id => document.getElementById(id) || {};
        const body = {
            enabled: !!el('mkt-sch-enabled').checked,
            time: el('mkt-sch-time').value || '07:30',
            days: el('mkt-sch-days').value || 'weekdays',
        };
        const msg = document.getElementById('mkt-sch-msg');
        let r = null;
        try {
            r = await Auth.apiCall('/api/bots/market/schedule', { method: 'POST', body: JSON.stringify(body) });
        } catch (e) { r = null; }
        if (!r || !r.ok) {
            if (msg) msg.textContent = Lang.t('market.error');
            return;
        }
        if (msg) msg.textContent = Lang.t('market.schedule_saved');
        this._loadSchedule();
    },

    // ------------------------------------------------------------- run

    async start() {
        if (this._running) return;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/run', { method: 'POST', body: JSON.stringify({}) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) {
            let detail = '';
            if (r) { try { detail = (await r.json()).detail || ''; } catch (e) { detail = ''; } }
            if (typeof Toast !== 'undefined' && Toast.error) Toast.error(detail || Lang.t('market.error'));
            return;
        }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        this._jobId = (d && d.job_id) || this._jobId;
        this._running = true;
        this._paintHeader();
        this._startPolling();
    },

    async stop() {
        if (!this._jobId) return;
        try { await Auth.apiCall('/api/bots/market/stop/' + encodeURIComponent(this._jobId), { method: 'POST' }); }
        catch (e) { /* ignore */ }
        this._running = false;
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
        this._paintHeader();
    },

    refresh() {
        this._loadSnapshot();
    },

    back() {
        this.unload();
        if (typeof BotsModule !== 'undefined' && BotsModule.render) BotsModule.render(BotsModule._container);
    },

    _startPolling() {
        if (this._pollInterval) clearInterval(this._pollInterval);
        this._pollInterval = setInterval(() => this._poll(), 3000);
    },

    async _poll() {
        if (!this._jobId) return;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/status/' + encodeURIComponent(this._jobId)); }
        catch (e) { return; }
        if (!r || !r.ok) return;
        let d = null;
        try { d = await r.json(); } catch (e) { return; }
        const status = d ? d.status : null;
        if (status && status !== 'running') {
            this._running = false;
            if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
            this._paintHeader();
            this._loadSnapshot();          // le run est fini : on relit les données fraîches
        } else {
            this._running = true;
            this._paintHeader();
        }
    },

    // ------------------------------------------------------------- téléchargements

    async downloadExcel() {
        await this._download('/api/bots/market/download/', 'xlsx');
    },

    async downloadReport() {
        await this._download('/api/bots/market/report/', 'txt');
    },

    async _download(prefix, ext) {
        if (!this._jobId) return;
        let r = null;
        try { r = await Auth.apiCall(prefix + encodeURIComponent(this._jobId)); } catch (e) { r = null; }
        if (!r || !r.ok) {
            if (typeof Toast !== 'undefined' && Toast.error) Toast.error(Lang.t('market.error'));
            return;
        }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'market-pulse-' + String(this._jobId).slice(0, 8) + '.' + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    },
};
