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
    _briefings: null,         // phase D : un briefing par bourse
    _prefs: null,             // {prefs, exchanges, groups, warnings}
    _clickBound: false,

    // ------------------------------------------------------------- cycle de vie

    async render(container) {
        this.unload();                       // coupe tout timer d'un rendu précédent
        this._container = container;
        container.innerHTML = this._shell();
        this._bindClicks();
        await this._loadActive();            // un run tourne déjà ?
        await this._loadSnapshot();
        // Les briefings et le sélecteur vivent dans LEURS conteneurs : le
        // rafraîchissement de l'horloge (60 s) ne doit pas effacer une case
        // qu'on est en train de cocher.
        this._loadBriefings();
        this._loadPrefs();
        if (this._isAdmin()) this._loadSchedule();
        this._refreshInterval = setInterval(() => this._loadSnapshot(), 60000);
    },

    unload() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
        if (this._refreshInterval) { clearInterval(this._refreshInterval); this._refreshInterval = null; }
        if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
        document.body.style.overflow = '';
        this._clickBound = false;
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
        // Phase D : le sélecteur, puis une TUILE par bourse. Conteneurs SÉPARÉS
        // de #mkt-body, que le poll de l'horloge réécrit toutes les 60 s.
        '<div id="mkt-selector"></div>' +
        '<div id="mkt-briefings"></div>' +
        '<div id="mkt-schedule"></div>' +
        '<div id="mkt-body"><div class="card">' + esc(Lang.t('market.loading')) + '</div></div>' +
        // L'overlay : une seule instance, remplie au clic sur une tuile.
        '<div id="mkt-overlay" style="display:none;"></div>';
    },

    // Un seul écouteur délégué sur le conteneur : les boutons porteurs de DONNÉES
    // passent par data-* (jamais un onclick avec une valeur interpolée — audit
    // sécurité 2026-06-21).
    _bindClicks() {
        if (this._clickBound || !this._container) return;
        this._container.addEventListener('click', (ev) => {
            const t = (ev.target && ev.target.closest) ? ev.target : null;
            if (!t) return;
            const follow = t.closest('[data-mkt-follow]');
            if (follow) {
                ev.preventDefault();
                ev.stopPropagation();          // ne pas ouvrir l'overlay au passage
                this.followSymbol(follow.getAttribute('data-mkt-venue'),
                                  follow.getAttribute('data-mkt-follow'));
                return;
            }
            if (t.closest('[data-mkt-close]')) { ev.preventDefault(); this.closeOverlay(); return; }
            const tile = t.closest('[data-mkt-open]');
            if (tile) { ev.preventDefault(); this.openOverlay(tile.getAttribute('data-mkt-open')); }
        });
        // Échap ferme : c'est le réflexe de tout le monde, et sur mobile le
        // bouton ✕ reste le chemin visible.
        this._onKey = (ev) => { if (ev.key === 'Escape') this.closeOverlay(); };
        document.addEventListener('keydown', this._onKey);
        this._clickBound = true;
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

    // =====================================================================
    //  PHASE D — un bloc par bourse, TOUT sous le nom de la bourse
    // =====================================================================
    //
    // Ordre voulu par Massii, et il ne change pas : état → indice → comparaison
    // → agenda → notizie (les FAITS d'abord) → titoli seguiti → nuovi titoli →
    // sintesi. Une section sans donnée le DIT ; elle ne disparaît pas et ne
    // reste pas vide — une case vide se lit comme « rien ne se passe », ce qui
    // est faux.

    async _loadBriefings() {
        const host = document.getElementById('mkt-briefings');
        if (!host) return;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/briefings'); } catch (e) { r = null; }
        if (!r || !r.ok) { host.innerHTML = ''; return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        this._briefings = d || null;
        host.innerHTML = this._briefingsHtml();
    },

    _briefingKeys() {
        const d = this._briefings;
        const map = (d && d.briefings && typeof d.briefings === 'object') ? d.briefings : null;
        const keys = map ? Object.keys(map) : [];
        // Les places dans l'ordre de leur ouverture : l'Asie, puis l'Europe,
        // puis New York — l'ordre dans lequel la journée s'est déroulée.
        const order = this._exchangeOrder();
        keys.sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        return keys;
    },

    // Une TUILE par bourse : le nom, les points, la variation, l'état. Tout le
    // reste vit derrière le clic — la page d'accueil doit tenir d'un coup d'œil.
    _briefingsHtml() {
        const map = (this._briefings && this._briefings.briefings) || null;
        const keys = this._briefingKeys();
        if (!keys.length) {
            return '<div class="card" style="margin-bottom:14px;color:var(--text-muted);">' +
                esc(Lang.t('market.no_briefings')) + '</div>';
        }
        return '<div style="display:grid;gap:12px;margin-bottom:14px;' +
                    'grid-template-columns:repeat(auto-fill,minmax(210px,1fr));">' +
            keys.map(k => this._tile(map[k])).join('') + '</div>';
    },

    _tile(b) {
        if (!b || typeof b !== 'object') return '';
        const m = b.index || {};
        const ch = this._change(m);
        const status = (m.clock && m.clock.status) || 'unknown';
        const state = status === 'open' ? Lang.t('market.status_open')
            : (status === 'closed' ? Lang.t('market.status_closed')
            : Lang.t('market.status_unknown'));
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        // Une place non cochée reste CLIQUABLE et lisible : elle a ses faits, on
        // ne lui a simplement pas dépensé de jetons. Elle passe au second plan,
        // elle ne disparaît pas.
        const dim = b.selected === false;
        return '<button class="card" data-mkt-open="' + esc(b.exchange || '') + '" ' +
               'style="text-align:left;cursor:pointer;padding:14px;margin:0;width:100%;' +
                      'display:flex;flex-direction:column;gap:6px;' +
                      'border:1px solid var(--border);' + (dim ? 'opacity:.72;' : '') +
                      'background:var(--bg-elev-1);color:var(--text);font:inherit;">' +
            '<div style="display:flex;align-items:baseline;gap:8px;">' +
              '<span style="font-size:17px;font-weight:600;">' + esc(b.label || b.exchange || '') + '</span>' +
              '<span class="badge' + (status === 'open' ? ' online' : '') +
                '" style="margin-left:auto;">' + esc(state) + '</span>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-dim);">' +
              esc(m.label || (b.session && b.session.opens_at) || '') + '</div>' +
            '<div style="display:flex;align-items:baseline;gap:10px;' + mono + '">' +
              '<span style="font-size:22px;">' + esc(this._price(m)) + '</span>' +
              '<span style="font-size:15px;color:' + this._color(ch.dir) + ';">' + esc(ch.txt) + '</span>' +
            '</div>' +
            '<div style="font-size:12px;color:' +
              (b.selected === false ? 'var(--text-dim)' : 'var(--accent)') + ';">' +
              esc(b.selected === false ? Lang.t('market.tile_facts_only')
                                       : Lang.t('market.tile_open')) + '</div>' +
        '</button>';
    },

    // ------------------------------------------------------------- overlay

    openOverlay(id) {
        const map = (this._briefings && this._briefings.briefings) || null;
        const b = (map && id) ? map[id] : null;
        const host = document.getElementById('mkt-overlay');
        if (!b || !host) return;
        host.innerHTML =
            '<div data-mkt-close="1" style="position:fixed;inset:0;z-index:9000;' +
                 'background:rgba(0,0,0,.72);display:flex;align-items:flex-start;' +
                 'justify-content:center;padding:24px 12px;overflow:auto;">' +
              // Le contenu ne ferme PAS au clic : seul le fond et le ✕ ferment.
              '<div onclick="event.stopPropagation()" class="card" ' +
                   'style="max-width:900px;width:100%;margin:0;position:relative;">' +
                '<button class="btn btn-ghost" data-mkt-close="1" ' +
                        'style="position:absolute;top:10px;right:10px;z-index:1;">' +
                  esc(Lang.t('market.close')) + '</button>' +
                this._briefingCard(b, true) +
              '</div>' +
            '</div>';
        host.style.display = '';
        // La page de dessous ne doit pas défiler pendant qu'on lit l'overlay.
        document.body.style.overflow = 'hidden';
        this._openId = id;
    },

    closeOverlay() {
        const host = document.getElementById('mkt-overlay');
        if (host) { host.innerHTML = ''; host.style.display = 'none'; }
        document.body.style.overflow = '';
        this._openId = null;
    },

    _exchangeOrder() {
        const groups = (this._prefs && Array.isArray(this._prefs.groups)) ? this._prefs.groups : [];
        const out = [];
        groups.forEach(g => (g.ids || []).forEach(id => { if (out.indexOf(id) < 0) out.push(id); }));
        return out;
    },

    // `bare` : dans l'overlay le cadre est déjà porté par la fenêtre, on ne
    // remet pas une carte dans une carte.
    _briefingCard(b, bare) {
        if (!b || typeof b !== 'object') return '';
        const s = b.session || {};
        const hours = [];
        if (s.opens_at) hours.push(Lang.t('market.opens_at') + ' ' + s.opens_at);
        if (s.closes_at) hours.push(Lang.t('market.closes_at') + ' ' + s.closes_at);
        if (s.lunch && s.lunch.length === 2) {
            hours.push(Lang.t('market.session_lunch') + ' ' + s.lunch[0] + '–' + s.lunch[1]);
        }
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        return (bare ? '<div>' : '<div class="card" style="margin-bottom:14px;">') +
            // --- le nom de la bourse : tout ce qui suit lui appartient ---
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;' +
                 'border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:12px;' +
                 (bare ? 'padding-right:110px;' : '') + '">' +
              '<h3 style="margin:0;font-size:20px;">' + esc(b.label || b.exchange || '') + '</h3>' +
              (b.country ? '<span style="font-size:13px;color:var(--text-muted);">' +
                  esc(b.country) + '</span>' : '') +
              (hours.length ? '<span style="font-size:12px;color:var(--text-dim);margin-left:auto;' + mono + '">' +
                  esc(hours.join(' · ')) + (s.tz ? ' (' + esc(s.tz) + ')' : '') + '</span>' : '') +
            '</div>' +
            this._bIndex(b.index) +
            this._bAgenda(b.agenda) +
            this._bNews(b.news) +
            this._bFollowed(b) +
            this._bDiscovered(b.exchange, b.discovered) +
            this._bSynthesis(b.analysis, b.selected) +
        '</div>';
    },

    _bHead(key) {
        return '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;' +
            'color:var(--text-dim);margin:14px 0 6px;">' + esc(Lang.t(key)) + '</div>';
    },

    _bEmpty(key) {
        return '<div style="font-size:14px;color:var(--text-muted);">' + esc(Lang.t(key)) + '</div>';
    },

    // --- l'indice de la place ------------------------------------------------

    _bIndex(m) {
        if (!m) return this._bHead('market.b_index') + this._bEmpty('market.no_data');
        const ch = this._change(m);
        const clock = m.clock || {};
        const state = clock.status === 'open' ? Lang.t('market.status_open')
            : (clock.status === 'closed' ? Lang.t('market.status_closed')
            : Lang.t('market.status_unknown'));
        const gap = this._gap(m);
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        return this._bHead('market.b_index') +
            '<div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;">' +
              '<span style="font-size:16px;font-weight:600;">' + esc(m.label || m.symbol || '') + '</span>' +
              '<span style="font-size:22px;' + mono + '">' + esc(this._price(m)) + '</span>' +
              '<span style="font-size:17px;' + mono + 'color:' + this._color(ch.dir) + ';">' +
                esc(ch.txt) + '</span>' +
              '<span class="badge' + (clock.status === 'open' ? ' online' : '') + '">' +
                esc(state) + '</span>' +
              (gap ? '<span style="font-size:13px;' + mono + 'color:var(--text-muted);">' +
                  esc(m.gap_is_today ? Lang.t('market.gap_today') : Lang.t('market.gap_last')) +
                  ' ' + esc(gap.txt) + '</span>' : '') +
            '</div>';
    },

    // --- l'agenda : une date est un fait, une direction n'en est pas un ------

    _bAgenda(rows) {
        const head = this._bHead('market.b_agenda');
        if (!Array.isArray(rows) || !rows.length) return head + this._bEmpty('market.agenda_empty');
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        return head + '<div class="row-list">' + rows.map(e => {
            const url = this._safeUrl(e.source_url);
            const what = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                  'style="color:var(--text);text-decoration:none;border-bottom:1px dotted var(--border-strong);">' +
                  esc(e.what || '') + '</a>'
                : esc(e.what || '');
            return '<div class="row" style="padding:8px 12px;display:block;">' +
                '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
                  '<span style="' + mono + 'color:var(--accent);font-size:13px;">' +
                    esc(this._agendaWhen(e)) + '</span>' +
                  '<span style="font-size:15px;">' + what + '</span>' +
                '</div>' +
                (e.at_stake
                    ? '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">' +
                      esc(Lang.t('market.agenda_at_stake')) + ' : ' + esc(e.at_stake) + '</div>'
                    : '') +
            '</div>';
        }).join('') + '</div>';
    },

    // Un titre de presse fait une ligne ; un post social fait un paragraphe, avec
    // son lien recopié au milieu. Mesuré sur un vrai run : un post Bluesky de
    // 300 caractères écrasait les cinq titres suivants. On enlève l'URL nue (elle
    // est déjà dans le lien du titre) et on coupe — proprement, à un mot.
    _headline(raw, max) {
        let s = String(raw == null ? '' : raw).replace(/https?:\/\/\S+/g, ' ');
        s = s.replace(/\s+/g, ' ').trim();
        const limit = max || 190;
        if (s.length <= limit) return s;
        const cut = s.slice(0, limit);
        const space = cut.lastIndexOf(' ');
        return (space > limit * 0.6 ? cut.slice(0, space) : cut) + '…';
    },

    // « 2026-07-31 » -> « 31/07/2026 » ; avec une heure -> « 31/07/2026 07:15 »
    _agendaWhen(e) {
        const raw = String((e && e.when) || '');
        if (!raw) return '—';
        if (e.day_only || raw.length <= 10) return this._date(raw);
        const d = new Date(raw);
        if (isNaN(d.getTime())) return raw;
        const p = x => (x < 10 ? '0' : '') + x;
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
            ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    // --- les notizie : les faits d'abord ------------------------------------

    _bNews(news) {
        const head = this._bHead('market.b_news');
        const items = (news && Array.isArray(news.items)) ? news.items : [];
        const alarms = (news && Array.isArray(news.alarms)) ? news.alarms : [];
        // Une alarme de collecte passe DEVANT : elle explique un briefing maigre.
        const alarmHtml = alarms.length
            ? '<div style="border:1px solid var(--warning);border-radius:var(--r-sm);padding:8px 10px;' +
              'margin-bottom:8px;font-size:13px;">' +
              alarms.map(a => esc(Lang.t('market.news_alarm') + ' : ' + a)).join('<br>') + '</div>'
            : '';
        if (!items.length) return head + alarmHtml + this._bEmpty('market.no_data');
        const rows = items.slice(0, 14).map(it => {
            const ev = (it && it.event) ? it.event : {};
            const url = this._safeUrl(it.url);
            // `title_display` porte la traduction quand il y en a une ; le titre
            // d'origine reste intact et reste consultable juste dessous.
            const shown = this._headline(it.title_display || it.title);
            const title = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                  'style="color:var(--text);text-decoration:none;">' + esc(shown) + '</a>'
                : esc(shown);
            const meta = [it.source, it.published ? this._dateTime(it.published) : '']
                .filter(Boolean).map(x => esc(String(x))).join(' · ');
            // Une news étrangère qu'on n'a PAS su traduire est montrée quand
            // même, et signalée : la masquer ferait un briefing creux qui a
            // l'air normal.
            const flag = it.translated
                ? '<span style="font-size:11px;color:var(--text-dim);">' +
                  esc(Lang.t('market.news_translated')) +
                  (it.lang ? ' · ' + esc(String(it.lang)) : '') + '</span>'
                : (it.needs_translation
                    ? '<span class="badge warn" style="font-size:11px;">' +
                      esc(Lang.t('market.news_untranslated')) + '</span>'
                    : '');
            // ⚠️ `display:block` explicite : `.row` du design system est un
            // conteneur FLEX, donc ces trois enfants se mettaient côte à côte —
            // le titre d'origine finissait en colonne d'un mot de large.
            return '<div class="row" style="padding:8px 12px;display:block;">' +
                '<div style="font-size:15px;line-height:1.4;">' +
                  (ev.is_event
                    ? '<span class="badge" style="margin-right:6px;">' +
                      esc(Lang.t('market.news_fact')) + '</span>'
                    : '') + title +
                '</div>' +
                (it.translated
                    ? '<div style="font-size:12px;color:var(--text-dim);margin-top:3px;' +
                           'font-style:italic;">' + esc(this._headline(it.title, 140)) + '</div>'
                    : '') +
                ((meta || flag)
                    ? '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;' +
                           'display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
                      meta + flag + '</div>'
                    : '') +
            '</div>';
        }).join('');
        // Transparence : on écarte des titres, on le dit.
        const notes = [];
        const adv = Number(news.filtered_advice) || 0;
        const off = Number(news.filtered_offtopic) || 0;
        if (adv) notes.push(Lang.t('market.news_filtered') + ' ' + adv);
        if (off) notes.push(Lang.t('market.news_offtopic') + ' ' + off);
        const stale = (news && Array.isArray(news.stale_sources)) ? news.stale_sources : [];
        if (stale.length) notes.push(Lang.t('market.news_stale') + ' ' + stale.join(', '));
        const failed = (news && Array.isArray(news.sources_failed)) ? news.sources_failed : [];
        if (failed.length) {
            notes.push(Lang.t('market.news_failed') + ' ' +
                failed.map(f => (f && f.source) || '?').join(', '));
        }
        return head + alarmHtml + '<div class="row-list">' + rows + '</div>' +
            (notes.length
                ? '<div style="font-size:12px;color:var(--text-dim);margin-top:6px;">' +
                  esc(notes.join(' · ')) + '</div>'
                : '');
    },

    // --- les titres suivis ---------------------------------------------------
    //
    // Vue AGRÉGÉE : tous les titres suivis, TOUTES bourses confondues — pas
    // seulement ceux de la place dont ce briefing parle (demande Massii du
    // 08/08 : « je veux une liste des titres que je suis », en remplacement de
    // la comparaison entre places). La place OUVERTE (b.exchange) passe en tête, les autres
    // suivent dans l'ordre d'ouverture (_briefingKeys) ; comme les lignes ne
    // viennent plus forcément de la bourse affichée, chaque ligne porte son
    // propre tag de place pour rester lisible une fois mélangées.

    _bFollowed(b) {
        const head = this._bHead('market.b_followed');
        const map = (this._briefings && this._briefings.briefings &&
            typeof this._briefings.briefings === 'object') ? this._briefings.briefings : {};
        const openExchange = (b && b.exchange) || null;

        // Place ouverte d'abord, puis les autres dans l'ordre d'ouverture —
        // sans dupliquer la place ouverte si elle réapparaît dans la liste.
        const orderedKeys = [];
        if (openExchange && map[openExchange]) orderedKeys.push(openExchange);
        this._briefingKeys().forEach(k => {
            if (map[k] && orderedKeys.indexOf(k) < 0) orderedKeys.push(k);
        });

        // this._briefings peut être null/incomplet, et un briefing peut ne pas
        // avoir de `followed` du tout : on ne suppose jamais la présence du champ.
        const seen = {};
        const rows = [];
        orderedKeys.forEach(venueId => {
            const vb = map[venueId];
            const followed = (vb && Array.isArray(vb.followed)) ? vb.followed : [];
            followed.forEach(f => {
                if (!f || typeof f !== 'object' || !f.symbol) return;
                const dedupKey = venueId + '|' + f.symbol;         // venue_id + symbol
                if (seen[dedupKey]) return;
                seen[dedupKey] = true;
                rows.push({ f: f, venueLabel: (vb && (vb.label || vb.exchange)) || venueId });
            });
        });

        if (!rows.length) return head + this._bEmpty('market.followed_empty_all');
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        return head + '<div class="row-list">' + rows.map(row => {
            const f = row.f;
            const n = Number(f.change_pct);
            const dir = isFinite(n) ? n : 0;
            return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                   'flex-wrap:wrap;padding:8px 12px;">' +
                '<div style="flex:1 1 180px;min-width:0;">' +
                  '<div style="font-size:15px;font-weight:600;">' + esc(f.label || f.symbol || '') + '</div>' +
                  '<div style="font-size:12px;color:var(--text-dim);">' +
                    '<span style="' + mono + '">' + esc(f.symbol || '') + '</span>' +
                    ' · <span style="font-size:12px;color:var(--text-dim);">' + esc(row.venueLabel || '') + '</span>' +
                  '</div>' +
                '</div>' +
                '<div style="' + mono + 'text-align:right;min-width:130px;">' +
                  '<div style="font-size:16px;">' + esc(this._money(f.price, f.currency)) + '</div>' +
                  '<div style="font-size:14px;color:' + this._color(dir) + ';">' +
                    esc(this._fmtSigned(f.change_pct, 2, '%')) + '</div>' +
                '</div>' +
                (f.error ? '<span class="badge danger">' + esc(String(f.error)) + '</span>' : '') +
            '</div>';
        }).join('') + '</div>';
    },

    // ⚠️ La devise s'affiche TELLE QUE la source la rend : Shell cote en GBp
    // (pence), 3 323,50 GBp = 33,24 £. Écrire « £ » serait faux d'un facteur 100.
    _money(price, currency) {
        if (price === null || price === undefined) return '—';
        const txt = this._fmt(price, 2);
        return currency ? (txt + ' ' + String(currency)) : txt;
    },

    // --- les nouveaux titres proposés ---------------------------------------

    _bDiscovered(venue, rows) {
        const head = this._bHead('market.b_discovered');
        if (!Array.isArray(rows) || !rows.length) return head + this._bEmpty('market.discovered_empty');
        const admin = this._isAdmin();
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';
        return head +
            '<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">' +
              esc(Lang.t('market.discovered_note')) + '</div>' +
            '<div class="row-list">' + rows.map(c => {
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;">' +
                    '<div style="flex:1 1 220px;min-width:0;">' +
                      '<div style="font-size:15px;">' + esc(c.name || c.symbol || '') +
                        ' <span style="' + mono + 'color:var(--text-dim);font-size:12px;">' +
                        esc(c.symbol || '') + '</span></div>' +
                      (c.headline ? '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">' +
                        esc(c.headline) + '</div>' : '') +
                    '</div>' +
                    '<span class="badge" style="' + mono + '">' +
                      esc(Lang.t('market.discovered_mentions') + ' ' + (Number(c.mentions) || 0)) + '</span>' +
                    (admin
                      ? '<button class="btn btn-sm" data-mkt-follow="' + esc(c.symbol || '') +
                        '" data-mkt-venue="' + esc(venue || '') + '">' +
                        esc(Lang.t('market.follow')) + '</button>'
                      : '') +
                '</div>';
            }).join('') + '</div>';
    },

    // --- la synthèse ---------------------------------------------------------

    _bSynthesis(a, selected) {
        const head = this._bHead('market.b_synthesis');
        // Une bourse non cochée n'est pas une PANNE : c'est un choix, celui de
        // ne pas dépenser de jetons dessus. Le dire autrement qu'un échec.
        if (selected === false) {
            return head +
                '<div style="font-size:14px;color:var(--text-muted);">' +
                  esc(Lang.t('market.not_selected')) + '</div>';
        }
        if (!a || !a.text) {
            const why = (a && a.reason) ? (' (' + a.reason + ')') : '';
            return head +
                '<div style="font-size:14px;color:var(--text-muted);">' +
                  esc(Lang.t('market.synthesis_degraded') + why) + '</div>';
        }
        return head +
            '<div style="font-size:15px;line-height:1.65;background:var(--bg-elev-3);' +
                 'padding:12px 14px;border-radius:var(--r-md);">' + esc(a.text) + '</div>' +
            (a.model ? '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">' +
                esc(a.model) + '</div>' : '');
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

    // =====================================================================
    //  PHASE D — le sélecteur : quelles bourses, quels titres
    // =====================================================================

    async _loadPrefs() {
        const host = document.getElementById('mkt-selector');
        if (!host) return;
        let r = null;
        try { r = await Auth.apiCall('/api/bots/market/prefs'); } catch (e) { r = null; }
        if (!r || !r.ok) { host.innerHTML = ''; return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        if (!d) { host.innerHTML = ''; return; }
        this._prefs = d;
        host.innerHTML = this._selectorHtml(d);
        // Les briefings s'ordonnent selon les groupes d'ouverture : maintenant
        // qu'on les connaît, on les redessine.
        const bhost = document.getElementById('mkt-briefings');
        if (bhost && this._briefings) bhost.innerHTML = this._briefingsHtml();
    },

    _selectorHtml(d) {
        const admin = this._isAdmin();
        const prefs = d.prefs || {};
        const chosen = Array.isArray(prefs.borse) ? prefs.borse : [];
        const titoli = (prefs.titoli && typeof prefs.titoli === 'object') ? prefs.titoli : {};
        const opz = (prefs.opzioni && typeof prefs.opzioni === 'object') ? prefs.opzioni : {};
        const rows = Array.isArray(d.exchanges) ? d.exchanges : [];
        const fires = {};
        (Array.isArray(d.groups) ? d.groups : []).forEach(g => {
            (g.ids || []).forEach(id => { fires[id] = g.fires_at; });
        });
        const dis = admin ? '' : ' disabled';
        const mono = 'font-family:var(--font-mono);font-feature-settings:\'tnum\';';

        const venues = rows.map(x => {
            const on = chosen.indexOf(x.id) >= 0;
            const syms = Array.isArray(titoli[x.id]) ? titoli[x.id].join(', ') : '';
            const places = (Array.isArray(x.places) && x.places.length)
                ? x.places.map(p => p.city).join(' · ') : '';
            return '<div style="border:1px solid var(--border);border-radius:var(--r-md);' +
                        'padding:10px 12px;margin-bottom:8px;">' +
                '<label style="display:flex;align-items:center;gap:9px;cursor:pointer;">' +
                  '<input type="checkbox" class="mkt-ex" value="' + esc(x.id) + '"' +
                    (on ? ' checked' : '') + dis +
                    ' style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" />' +
                  '<span style="font-size:15px;font-weight:600;">' + esc(x.label || x.id) + '</span>' +
                  '<span style="font-size:12px;color:var(--text-dim);' + mono + '">' +
                    esc((x.index_label || '') + ' · ' + (x.opens_at || '')) +
                    (fires[x.id] ? ' → ' + esc(Lang.t('market.fires_at')) + ' ' + esc(fires[x.id]) : '') +
                  '</span>' +
                '</label>' +
                (places ? '<div style="font-size:11px;color:var(--text-dim);margin:3px 0 0 25px;">' +
                    esc(places) + '</div>' : '') +
                '<div style="margin:8px 0 0 25px;">' +
                  '<label class="form-label" style="font-size:11px;">' +
                    esc(Lang.t('market.selector_titles')) + '</label>' +
                  '<input class="form-input mkt-sym" data-venue="' + esc(x.id) + '"' + dis +
                    ' value="' + esc(syms) + '" placeholder="RACE.MI, ASML.AS" />' +
                '</div>' +
            '</div>';
        }).join('');

        const flag = (key, labelKey) =>
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">' +
              '<input type="checkbox" class="mkt-opt" data-opt="' + esc(key) + '"' +
                (opz[key] ? ' checked' : '') + dis +
                ' style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;" />' +
              '<span>' + esc(Lang.t(labelKey)) + '</span></label>';

        const warn = (Array.isArray(d.warnings) && d.warnings.length)
            ? '<div style="font-size:12px;color:var(--warning);margin-bottom:8px;">' +
              d.warnings.map(w => esc(w)).join('<br>') + '</div>'
            : '';

        return '<div class="card" style="margin-bottom:14px;">' +
            '<details' + (this._selectorOpen ? ' open' : '') +
                ' ontoggle="MarketModule._selectorOpen=this.open">' +
              '<summary style="cursor:pointer;font-size:17px;font-weight:600;padding:2px 0;">' +
                esc(Lang.t('market.selector_title')) + '</summary>' +
              '<div style="margin-top:12px;">' +
                warn +
                '<div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">' +
                  esc(Lang.t('market.selector_hint')) + '</div>' +
                venues +
                '<div style="margin-top:12px;font-size:12px;letter-spacing:.06em;' +
                     'text-transform:uppercase;color:var(--text-dim);">' +
                  esc(Lang.t('market.selector_options')) + '</div>' +
                '<div style="display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 10px;">' +
                  flag('reddit', 'market.opt_reddit') +
                  flag('bluesky', 'market.opt_bluesky') +
                  flag('x', 'market.opt_x') +
                  flag('sintesi', 'market.opt_sintesi') +
                  flag('scoperte', 'market.opt_scoperte') +
                  flag('quaderno', 'market.opt_quaderno') +
                '</div>' +
                '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">' +
                  '<div style="flex:0 1 150px;">' +
                    '<label class="form-label">' + esc(Lang.t('market.opt_max_notizie')) + '</label>' +
                    '<input id="mkt-max-notizie" class="form-input" type="number" min="1" max="50"' +
                      dis + ' value="' + esc(String(opz.max_notizie || 10)) + '" />' +
                  '</div>' +
                  // La langue de LECTURE : les titres étrangers y sont traduits.
                  '<div style="flex:0 1 190px;">' +
                    '<label class="form-label">' + esc(Lang.t('market.opt_lingua')) + '</label>' +
                    '<select id="mkt-lingua" class="form-input"' + dis + '>' +
                      ['it', 'fr', 'en'].map(code =>
                        '<option value="' + code + '"' +
                        ((opz.lingua || 'it') === code ? ' selected' : '') + '>' +
                        esc(Lang.t('market.lingua_' + code)) + '</option>').join('') +
                    '</select>' +
                  '</div>' +
                  (admin
                    ? '<button class="btn btn-primary" onclick="MarketModule.savePrefs()">' +
                      esc(Lang.t('market.selector_save')) + '</button>'
                    : '<span style="font-size:12px;color:var(--text-dim);">' +
                      esc(Lang.t('market.selector_readonly')) + '</span>') +
                  '<span id="mkt-pref-msg" style="font-size:12px;color:var(--text-dim);"></span>' +
                '</div>' +
              '</div>' +
            '</details>' +
        '</div>';
    },

    _selectorOpen: false,

    // Lit l'état des cases et l'envoie. Le backend re-valide et RÉINSTALLE les
    // réveils : décocher une bourse éteint vraiment son briefing du matin.
    async savePrefs() {
        const body = this._collectPrefs();
        const msg = document.getElementById('mkt-pref-msg');
        let r = null;
        try {
            r = await Auth.apiCall('/api/bots/market/prefs',
                { method: 'POST', body: JSON.stringify(body) });
        } catch (e) { r = null; }
        if (!r || !r.ok) {
            if (msg) msg.textContent = Lang.t('market.error');
            return;
        }
        if (msg) msg.textContent = Lang.t('market.selector_saved');
        await this._loadPrefs();
    },

    _collectPrefs() {
        const borse = [];
        document.querySelectorAll('#mkt-selector .mkt-ex').forEach(el => {
            if (el.checked) borse.push(el.value);
        });
        const titoli = {};
        document.querySelectorAll('#mkt-selector .mkt-sym').forEach(el => {
            const venue = el.getAttribute('data-venue');
            const syms = String(el.value || '').split(',')
                .map(s => s.trim()).filter(Boolean);
            if (venue && syms.length && borse.indexOf(venue) >= 0) titoli[venue] = syms;
        });
        const opzioni = {};
        document.querySelectorAll('#mkt-selector .mkt-opt').forEach(el => {
            opzioni[el.getAttribute('data-opt')] = !!el.checked;
        });
        const max = document.getElementById('mkt-max-notizie');
        if (max) {
            const n = parseInt(max.value, 10);
            if (isFinite(n)) opzioni.max_notizie = n;
        }
        const lingua = document.getElementById('mkt-lingua');
        if (lingua && lingua.value) opzioni.lingua = lingua.value;
        return { borse: borse, titoli: titoli, opzioni: opzioni };
    },

    // Depuis « nuovi titoli » : ajouter un symbole à la liste suivie. C'est LUI
    // qui choisit — le bot ne fait que signaler ce qui est apparu.
    async followSymbol(venue, symbol) {
        if (!venue || !symbol || !this._prefs) return;
        const prefs = this._prefs.prefs || {};
        const borse = Array.isArray(prefs.borse) ? prefs.borse.slice() : [];
        const titoli = {};
        Object.keys(prefs.titoli || {}).forEach(k => { titoli[k] = (prefs.titoli[k] || []).slice(); });
        titoli[venue] = titoli[venue] || [];
        if (titoli[venue].indexOf(symbol) < 0) titoli[venue].push(symbol);
        let r = null;
        try {
            r = await Auth.apiCall('/api/bots/market/prefs', {
                method: 'POST',
                body: JSON.stringify({ borse: borse, titoli: titoli, opzioni: prefs.opzioni || {} }),
            });
        } catch (e) { r = null; }
        if (!r || !r.ok) {
            if (typeof Toast !== 'undefined' && Toast.error) Toast.error(Lang.t('market.error'));
            return;
        }
        if (typeof Toast !== 'undefined' && Toast.success) {
            Toast.success(Lang.t('market.follow_added') + ' ' + symbol);
        }
        await this._loadPrefs();
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
        this._loadBriefings();
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
            this._loadBriefings();         // ... y compris les briefings par bourse
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
