// frontend/js/paper_module.js
// Vue dédiée « Paper Trading » : simulateur de trading actif en argent fictif
// (CHF) sur des cours réels, doublé d'un coach à mémoire persistante.
//
// Le backend est figé par le contrat §9 de
// docs/superpowers/specs/2026-08-24-paper-trading-design.md (préfixe /api/paper).
// Ce module ne fait que LIRE ce contrat : il ne décide rien, il n'invente aucun
// chiffre, et il affiche les avertissements du backend sans jamais bloquer.
//
// Contraintes du dépôt respectées ici :
//   - vanilla JS, zéro dépendance, zéro CDN (composants Bento + inline minimal) ;
//   - concaténation de chaînes en quotes simples, JAMAIS de template literal :
//     un backtick perdu dans du HTML embarqué tue le module entier (piège #28) ;
//   - toute donnée dynamique passe par esc() avant innerHTML (audit 2026-06-21) ;
//   - un bouton porteur de DONNÉES passe par data-* + délégation, jamais par un
//     onclick avec une valeur interpolée ;
//   - tout texte d'interface passe par Lang.t() — aucune chaîne en dur ;
//   - appels API uniquement via Auth.apiCall() ;
//   - couleurs par TOKENS uniquement (le mode clair « Givre » suit tout seul).
//
// Lecture : nombres en CHF au format suisse (10’000.00), R multiple coloré
// (accent = positif, danger = négatif) — c'est le R qui apprend le risque, pas
// le pourcentage de gain.
const PaperModule = {
    // ------------------------------------------------------------------ état
    _container: null,
    _host: null,               // élément qui porte les écouteurs délégués
    _onClick: null,
    _onInput: null,
    _refresh: null,            // tick + portefeuille toutes les 60 s
    _searchTimer: null,        // anti-rebond 400 ms de la recherche

    _tab: 'portfolio',
    _p: null,                  // portefeuille normalisé
    _news: null,               // veille des positions : [{ts,symbol,title,link,sentiment}]
    _coach: null,              // {biases, summary}
    _notes: null,              // carnet : [{name,size,modified}]
    _noteName: null,
    _noteBody: null,
    _lessons: null,
    _lessonId: null,
    _quizResult: null,
    _arena: null,
    _whales: null,            // {managers:[{id,label,cached,quarter}]}
    _whaleId: null,           // gerant selectionne
    _whaleSnap: null,         // instantane 13F du gerant selectionne
    _whaleLoading: false,     // le fetch SEC a froid dure ~10 s
    _whaleEvents: null,       // fil des derniers depots
    _radar: null,             // {stats, hypotheses}
    _tradeIdx: null,           // journal : trade ouvert en détail
    _postmortem: null,
    _answer: null,             // réponse du coach
    _analysis: null,           // fiche d'analyse
    _results: null,            // résultats de recherche
    _pick: null,               // {symbol,name,exchange,currency}
    _quote: null,              // {price,currency,change_pct,fx_rate_chf}
    _form: {},                 // survit aux re-rendus du corps

    _mono: 'font-family:var(--font-mono);font-feature-settings:\'tnum\';',

    // ------------------------------------------------------------ cycle de vie

    async render(container) {
        this.unload();                       // coupe tout timer d'un rendu précédent
        this._container = container;
        if (!container) return;
        container.innerHTML = this._shell();
        this._bind();
        this._renderTabs();
        await this._tickAndLoad();
        this._renderBody();
        // Un seul rendez-vous périodique : passer les ordres en attente puis
        // relire le portefeuille. Il ne réécrit le corps que si l'onglet
        // Portefeuille est affiché — sinon il effacerait un formulaire en cours
        // de saisie (leçon du sélecteur Market Pulse).
        this._refresh = setInterval(() => this._periodic(), 60000);
    },

    unload() {
        if (this._refresh) { clearInterval(this._refresh); this._refresh = null; }
        if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
        if (this._host && this._onClick) this._host.removeEventListener('click', this._onClick);
        if (this._host && this._onInput) {
            this._host.removeEventListener('input', this._onInput);
            this._host.removeEventListener('change', this._onInput);
        }
        this._host = null;
        this._onClick = null;
        this._onInput = null;
    },

    // Un seul écouteur délégué par type, POSÉ SUR LE CONTENEUR (qui survit aux
    // réécritures de innerHTML) et RETIRÉ au déchargement — sinon chaque
    // aller-retour vers l'onglet en empilerait un de plus.
    _bind() {
        const host = this._container;
        if (!host) return;
        this._host = host;
        this._onClick = (ev) => this._click(ev);
        this._onInput = (ev) => this._input(ev);
        host.addEventListener('click', this._onClick);
        host.addEventListener('input', this._onInput);
        host.addEventListener('change', this._onInput);
    },

    back() {
        this.unload();
        if (typeof BotsModule !== 'undefined' && BotsModule.render) {
            BotsModule.render(BotsModule._container);
        }
    },

    // --------------------------------------------------------------- outillage

    _toast(kind, msg) {
        if (typeof Toast === 'undefined' || !Toast[kind]) return;
        Toast[kind](msg);
    },

    // Nombre → null quand ce n'est pas un nombre exploitable (le backend peut
    // rendre null, '' ou un champ absent : on ne suppose jamais sa présence).
    _n(v) {
        const n = Number(v);
        if (v === null || v === undefined || v === '' || !isFinite(n)) return null;
        return n;
    },

    // Premier champ non nul parmi des alias (le contrat fige les concepts, pas
    // toujours le nom exact du champ : on lit tolérant, on n'invente rien).
    _pickField(obj, keys) {
        if (!obj || typeof obj !== 'object') return null;
        for (let i = 0; i < keys.length; i++) {
            const v = obj[keys[i]];
            if (v !== null && v !== undefined && v !== '') return v;
        }
        return null;
    },

    // 10000 -> « 10’000.00 » (séparateur de milliers suisse : apostrophe typographique)
    _num(v, dec) {
        const n = this._n(v);
        if (n === null) return '—';
        const d = (dec === null || dec === undefined) ? 2 : dec;
        const parts = Math.abs(n).toFixed(d).split('.');
        const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '’');
        return (n < 0 ? '-' : '') + int + (parts[1] ? '.' + parts[1] : '');
    },

    _signed(v, dec, unit) {
        const n = this._n(v);
        if (n === null) return '—';
        return (n > 0 ? '+' : '') + this._num(n, dec) + (unit || '');
    },

    _chf(v, dec) {
        const s = this._num(v, dec);
        return s === '—' ? s : (s + ' CHF');
    },

    _signedChf(v, dec) {
        const s = this._signed(v, dec, '');
        return s === '—' ? s : (s + ' CHF');
    },

    _money(v, currency, dec) {
        const s = this._num(v, dec === undefined ? 2 : dec);
        if (s === '—') return s;
        return currency ? (s + ' ' + String(currency)) : s;
    },

    _color(dir) {
        const n = this._n(dir);
        if (n === null || n === 0) return 'var(--text-muted)';
        return n > 0 ? 'var(--accent)' : 'var(--danger)';
    },

    // Accepte un ISO (« 2026-08-24T09:12:00 ») comme un epoch en secondes.
    _toDate(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (isFinite(n) && typeof v !== 'string') return new Date(n * 1000);
        if (isFinite(n) && /^\d+$/.test(String(v))) return new Date(n * 1000);
        const d = new Date(String(v));
        return isNaN(d.getTime()) ? null : d;
    },

    _date(v) {
        const d = this._toDate(v);
        if (!d) return '—';
        const p = (x) => (x < 10 ? '0' : '') + x;
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    },

    _dateTime(v) {
        const d = this._toDate(v);
        if (!d) return '—';
        const p = (x) => (x < 10 ? '0' : '') + x;
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
            ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    // Une clé i18n absente est rendue TELLE QUELLE par Lang.t (elle est donc
    // « truthy ») : le || ne peut pas servir de repli (piège #12).
    _label(key, fallback) {
        const v = Lang.t(key);
        return (String(v).indexOf(key) === 0) ? String(fallback == null ? '' : fallback) : v;
    },

    _sideLabel(side) {
        const s = String(side || '').toLowerCase();
        return this._label('paper.side_' + s, side);
    },

    _kindLabel(kind) {
        const k = String(kind || '').toLowerCase();
        return this._label('paper.kind_' + k, kind);
    },

    _biasLabel(code) {
        const c = String(code || '');
        return this._label('paper.bias_' + c, c);
    },

    // Un href ne part JAMAIS dans le DOM sans être vérifié : seuls http(s)
    // passent (une URL vient du flux de presse, donc de l'extérieur).
    _safeUrl(u) {
        const s = String(u == null ? '' : u);
        return /^https?:\/\//i.test(s) ? s : '';
    },

    async _detail(r) {
        if (!r) return Lang.t('paper.error');
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        const msg = d && (d.detail || d.message || d.error);
        return msg ? String(msg) : (Lang.t('paper.error') + ' (' + r.status + ')');
    },

    async _get(url) {
        let r = null;
        try { r = await Auth.apiCall(url); } catch (e) { r = null; }
        if (!r || !r.ok) return null;
        try { return await r.json(); } catch (e) { return null; }
    },

    // ------------------------------------------------------------- coquille

    _shell() {
        return '' +
        '<div class="card" style="margin-bottom:14px;">' +
          // .b-head / .b-icon / .b-name-wrap sont scopés à .bot-card-bento dans
          // style.css : hors carte-bot ils ne posent AUCUNE mise en page. On
          // aligne donc en flex inline ; .b-ticker, lui, est bien global.
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<span class="b-ticker">SIM</span>' +
            '<div>' +
              '<div style="font-size:17px;font-weight:600;">' + esc(Lang.t('paper.title')) + '</div>' +
              '<div style="font-size:13px;color:var(--text-muted);">' + esc(Lang.t('paper.subtitle')) + '</div>' +
            '</div>' +
            '<span class="badge" id="paper-feebadge" style="margin-left:auto;"></span>' +
          '</div>' +
          '<div style="font-size:14px;line-height:1.55;color:var(--text-muted);margin-bottom:10px;">' +
            esc(Lang.t('paper.desc')) + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="btn btn-ghost" data-paper-act="refresh">' + esc(Lang.t('paper.refresh')) + '</button>' +
            '<button class="btn btn-ghost" data-paper-act="back">' + esc(Lang.t('paper.back')) + '</button>' +
          '</div>' +
        '</div>' +
        // Rappel permanent : argent fictif, cours différés, aucun conseil.
        '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
             'background:var(--bg-elev-2);font-size:14px;line-height:1.5;">' +
          esc(Lang.t('paper.disclaimer')) +
        '</div>' +
        '<div class="paper-tabs" id="paper-tabs"></div>' +
        '<div id="paper-body"><div class="card">' + esc(Lang.t('paper.loading')) + '</div></div>';
    },

    _tabDefs() {
        return [
            ['portfolio', 'paper.tab_portfolio'],
            ['trade', 'paper.tab_trade'],
            ['journal', 'paper.tab_journal'],
            ['coach', 'paper.tab_coach'],
            ['lessons', 'paper.tab_lessons'],
            ['arena', 'paper.tab_arena'],
            ['whales', 'paper.tab_whales'],
            ['radar', 'paper.tab_radar'],
        ];
    },

    _renderTabs() {
        const host = document.getElementById('paper-tabs');
        if (!host) return;
        host.innerHTML = this._tabDefs().map((d) =>
            '<button class="paper-tab' + (this._tab === d[0] ? ' active' : '') + '" ' +
                'data-paper-tab="' + esc(d[0]) + '">' + esc(Lang.t(d[1])) + '</button>'
        ).join('');
    },

    _setBody(html) {
        const body = document.getElementById('paper-body');
        if (body) body.innerHTML = html;
    },

    _card(inner, extra) {
        return '<div class="card" style="margin-bottom:14px;' + (extra || '') + '">' + inner + '</div>';
    },

    _head(title, note) {
        return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<h3 style="margin:0;font-size:17px;">' + esc(title) + '</h3>' +
            (note ? '<span style="font-size:12px;color:var(--text-dim);">' + esc(note) + '</span>' : '') +
        '</div>';
    },

    _sub(key) {
        return '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;' +
            'color:var(--text-dim);margin:14px 0 6px;">' + esc(Lang.t(key)) + '</div>';
    },

    _muted(txt) {
        return '<div style="font-size:14px;color:var(--text-muted);">' + esc(txt) + '</div>';
    },

    // Panneau de texte long (réponse du coach, post-mortem, fiche d'analyse).
    _panel(title, text) {
        return '<div style="margin-top:12px;">' +
            '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;' +
                 'color:var(--text-dim);margin-bottom:6px;">' + esc(title) + '</div>' +
            '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;' +
                 'font-family:var(--font-mono);font-size:13px;line-height:1.6;' +
                 'background:var(--bg-elev-3);padding:12px 14px;border-radius:var(--r-md);' +
                 'max-height:460px;overflow:auto;">' + esc(text) + '</pre>' +
        '</div>';
    },

    _th() { return 'text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);' +
        'font-size:12px;color:var(--text-dim);font-weight:500;white-space:nowrap;'; },
    _td() { return 'padding:7px 10px;border-bottom:1px solid var(--border);font-size:14px;'; },

    _table(heads, rows) {
        if (!rows) return '';
        return '<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;min-width:520px;">' +
            '<thead><tr>' + heads.map((h) => '<th style="' + this._th() + '">' + esc(h) + '</th>').join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    },

    // ------------------------------------------------------------- chargement

    async _tickAndLoad() {
        await this._tick();
        await this._loadPortfolio();
        await this._loadNews();
    },

    // Veille de presse sur les positions détenues. Les alertes partent déjà sur
    // Telegram côté backend : ici c'est l'HISTORIQUE, pas la notification.
    async _loadNews() {
        const d = await this._get('/api/paper/news');
        if (!d) return;
        this._news = Array.isArray(d) ? d : (Array.isArray(d.events) ? d.events : []);
    },

    // POST /tick : passe les ordres en attente et les stops contre les bougies
    // récentes. Chaque exécution est signalée — un ordre qui part sans qu'on le
    // voie, c'est la moitié de la leçon perdue.
    async _tick() {
        let r = null;
        try { r = await Auth.apiCall('/api/paper/tick', { method: 'POST', body: JSON.stringify({}) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) return;
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        const fills = (d && Array.isArray(d.fills)) ? d.fills : [];
        fills.forEach((f) => this._toast('info', this._fillLine(f)));
    },

    _fillLine(f) {
        if (!f || typeof f !== 'object') return Lang.t('paper.fill');
        const parts = [Lang.t('paper.fill')];
        if (f.symbol) parts.push(String(f.symbol));
        if (f.side) parts.push(this._sideLabel(f.side));
        const qty = this._n(this._pickField(f, ['qty', 'quantity']));
        if (qty !== null) parts.push(this._num(qty, 0));
        const px = this._n(this._pickField(f, ['price', 'fill_price', 'exec_price']));
        if (px !== null) parts.push('@ ' + this._num(px, 2));
        return parts.join(' ');
    },

    async _loadPortfolio() {
        const d = await this._get('/api/paper/portfolio');
        if (d) this._p = this._normalize(d);
        this._paintFeeBadge();
    },

    // Le portefeuille est la seule source de vérité de la vue : on le remet à
    // plat une fois pour toutes, avec des alias tolérants sur les noms de champs.
    _normalize(d) {
        const raw = (d && typeof d === 'object') ? d : {};
        const p = (raw.portfolio && typeof raw.portfolio === 'object') ? raw.portfolio : raw;
        const arr = (v) => (Array.isArray(v) ? v : []);
        const obj = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : {});
        return {
            cash: this._n(this._pickField(p, ['cash_chf', 'cash'])),
            positions: arr(p.positions),
            orders: arr(this._pickField(p, ['open_orders', 'orders']) || []),
            trades: arr(p.trades),
            fee_profile: p.fee_profile || null,
            initial_capital: this._n(this._pickField(p, ['initial_capital', 'initial_capital_chf'])),
            exposure: obj(raw.exposure || p.exposure),
            afc: obj(raw.afc || p.afc),
            stats: obj(raw.stats || p.stats),
            biases: arr(raw.biases || p.biases),
            equity: this._equitySeries(raw, p),
        };
    },

    // La courbe d'équité peut arriver en nombres bruts ou en points datés.
    _equitySeries(raw, p) {
        const st = (raw.stats && typeof raw.stats === 'object') ? raw.stats : {};
        const src = this._pickField(st, ['equity_curve', 'equity']) ||
            this._pickField(raw, ['equity_curve', 'equity']) ||
            this._pickField(p, ['equity_curve', 'equity']);
        if (!Array.isArray(src)) return [];
        const out = [];
        src.forEach((pt) => {
            let v = null;
            if (pt && typeof pt === 'object') {
                v = this._n(this._pickField(pt, ['value', 'equity', 'total', 'total_value_chf', 'value_chf']));
            } else {
                v = this._n(pt);
            }
            if (v !== null) out.push(v);
        });
        return out;
    },

    _paintFeeBadge() {
        const el = document.getElementById('paper-feebadge');
        if (!el) return;
        const prof = this._p ? this._p.fee_profile : null;
        el.textContent = prof ? (Lang.t('paper.form_fee_profile') + ' ' + this._feeLabel(prof)) : '';
    },

    _feeLabel(id) { return this._label('paper.fee_' + String(id || '').toLowerCase(), id); },

    // Valeur totale : le champ du backend s'il existe, sinon reconstruite —
    // jamais un « — » silencieux quand l'information est calculable.
    _totalValue() {
        const p = this._p;
        if (!p) return null;
        const direct = this._n(this._pickField(p.stats, ['total_value_chf', 'total_value', 'equity_chf', 'equity'])) ;
        if (direct !== null) return direct;
        const exp = this._n(this._pickField(p.exposure, ['total_value_chf', 'total_value']));
        if (exp !== null) return exp;
        if (p.cash === null) return null;
        let sum = p.cash;
        p.positions.forEach((pos) => {
            const v = this._n(this._pickField(pos, ['value_chf', 'market_value_chf', 'value']));
            if (v !== null) { sum += v; return; }
            const qty = this._n(pos.qty);
            const last = this._n(this._pickField(pos, ['last_price', 'price', 'last']));
            const fx = this._n(this._pickField(pos, ['fx_rate_chf', 'fx'])) || 1;
            if (qty !== null && last !== null) sum += qty * last * fx;
        });
        return sum;
    },

    _pnlTotal() {
        const p = this._p;
        if (!p) return { chf: null, pct: null };
        let chf = this._n(this._pickField(p.stats, ['pnl_chf', 'pnl_total_chf', 'total_pnl_chf']));
        let pct = this._n(this._pickField(p.stats, ['pnl_pct', 'pnl_total_pct', 'total_pnl_pct']));
        const tv = this._totalValue();
        if (chf === null && tv !== null && p.initial_capital !== null) chf = tv - p.initial_capital;
        if (pct === null && chf !== null && p.initial_capital) pct = (chf / p.initial_capital) * 100;
        return { chf: chf, pct: pct };
    },

    _feesTotal() {
        const p = this._p;
        if (!p) return null;
        const direct = this._n(this._pickField(p.stats, ['fees_total_chf', 'fees_chf', 'total_fees_chf']));
        if (direct !== null) return direct;
        if (!p.trades.length) return null;
        let sum = 0;
        p.trades.forEach((t) => {
            sum += (this._n(t.fees_chf) || 0) + (this._n(t.stamp_duty_chf) || 0);
        });
        return sum;
    },

    // Capital de référence du calcul de taille : ce que le portefeuille VAUT
    // aujourd'hui, pas ce qu'il valait au départ.
    _capital() {
        const tv = this._totalValue();
        if (tv !== null) return tv;
        const p = this._p;
        if (p && p.initial_capital !== null) return p.initial_capital;
        return null;
    },

    // --------------------------------------------------------------- routage

    async _periodic() {
        await this._tick();
        await this._loadPortfolio();
        await this._loadNews();
        // On ne réécrit le corps que là où aucune saisie n'est en cours.
        if (this._tab === 'portfolio') this._renderBody();
    },

    switchTab(tab) {
        if (!tab || tab === this._tab) return;
        if (this._tab === 'trade') this._captureForm();
        this._tab = tab;
        this._renderTabs();
        this._renderBody();
        this._loadTab();
    },

    // Chargements paresseux : un onglet ne va chercher ses données que la
    // première fois qu'on l'ouvre (le coach et l'arène ne bougent pas à la minute).
    async _loadTab() {
        if (this._tab === 'whales' && !this._whales) {
            this._whales = await this._get('/api/paper/whales') || {};
            this._whaleEvents = await this._get('/api/paper/whales/events');
            if (this._tab === 'whales') this._renderBody();
            return;
        }
        if (this._tab === 'radar' && !this._radar) {
            this._radar = await this._get('/api/paper/radar') || {};
            if (this._tab === 'radar') this._renderBody();
            return;
        }
        if (this._tab === 'coach' && !this._coach) {
            this._coach = await this._get('/api/paper/coach') || {};
            this._notes = await this._get('/api/paper/coach/notes');
            if (this._tab === 'coach') this._renderBody();
            return;
        }
        if (this._tab === 'lessons' && !this._lessons) {
            this._lessons = await this._get('/api/paper/lessons') || {};
            if (this._tab === 'lessons') this._renderBody();
            return;
        }
        if (this._tab === 'arena' && !this._arena) {
            this._arena = await this._get('/api/paper/arena') || {};
            if (this._tab === 'arena') this._renderBody();
        }
    },

    _renderBody() {
        if (this._tab === 'trade') return this._setBody(this._viewTrade());
        if (this._tab === 'journal') return this._setBody(this._viewJournal());
        if (this._tab === 'coach') return this._setBody(this._viewCoach());
        if (this._tab === 'lessons') return this._setBody(this._viewLessons());
        if (this._tab === 'arena') return this._setBody(this._viewArena());
        if (this._tab === 'whales') return this._setBody(this._viewWhales());
        if (this._tab === 'radar') return this._setBody(this._viewRadar());
        this._setBody(this._viewPortfolio());
        this._paintEquity();
    },

    async refresh() {
        await this._tickAndLoad();
        // Un rafraîchissement demandé À LA MAIN relit aussi l'onglet courant.
        if (this._tab === 'coach') {
            this._coach = await this._get('/api/paper/coach') || {};
            this._notes = await this._get('/api/paper/coach/notes');
        } else if (this._tab === 'lessons') {
            this._lessons = await this._get('/api/paper/lessons') || {};
        } else if (this._tab === 'arena') {
            this._arena = await this._get('/api/paper/arena') || {};
        } else if (this._tab === 'whales') {
            this._whales = await this._get('/api/paper/whales') || {};
            this._whaleEvents = await this._get('/api/paper/whales/events');
            // Un gerant deja ouvert est relu aussi : c'est un rafraichissement
            // DEMANDE, on assume les ~10 s (le loader le dit).
            if (this._whaleId) { this._renderBody(); await this.openWhale(this._whaleId, true); return; }
        } else if (this._tab === 'radar') {
            this._radar = await this._get('/api/paper/radar') || {};
        }
        this._renderBody();
    },

    // =====================================================================
    //  1. PORTEFEUILLE
    // =====================================================================

    _viewPortfolio() {
        if (!this._p) return this._card(this._muted(Lang.t('paper.no_data')));
        return this._statCards() + this._equityCard() + this._positionsCard() +
            this._ordersCard() + this._newsCard() + this._resetCard();
    },

    // --- Actualités des positions -------------------------------------------
    //
    // Composant Bento .row/.row-list + .badge. (Le .events-feed a été essayé :
    // sa colonne 'typ' fait 80 px fixes et coupait « CATALYSEUR À VENIR » —
    // vérifié à l'écran. Le badge est de toute façon LE composant du projet
    // pour un statut.)

    // « watch » n'est ni bon ni mauvais : c'est un catalyseur À VENIR (résultats
    // annoncés, OPA, lancement). Il mérite sa propre couleur — le classer en
    // positif ferait lire une nouvelle comme un avis, ce que le module ne fait jamais.
    _sentiment(v) {
        const s = String(v == null ? '' : v).toLowerCase();
        if (s === 'neg') return { cls: 'danger', color: 'var(--danger)', key: 'paper.news_neg' };
        if (s === 'watch') return { cls: 'warn', color: 'var(--warning)', key: 'paper.news_watch' };
        // Une annonce politique/presidentielle n'est pas un jugement sur le titre :
        // elle signale d'ou vient le mouvement, pas s'il est bon.
        if (s === 'gov') return { cls: 'warn', color: 'var(--warning)', key: 'paper.news_gov' };
        return { cls: 'online', color: 'var(--accent)', key: 'paper.news_pos' };
    },

    _newsCard() {
        const rows = Array.isArray(this._news) ? this._news : [];
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.news_title')) +
                this._muted(Lang.t('paper.news_empty')));
        }
        const feed = rows.map((e) => {
            const s = this._sentiment(e && e.sentiment);
            const url = this._safeUrl(e && e.link);
            const link = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                  'class="btn btn-ghost btn-sm" style="text-decoration:none;">' +
                  esc(Lang.t('paper.open')) + '</a>'
                : '';
            return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
                   'flex-wrap:wrap;padding:9px 12px;">' +
                '<span class="badge ' + s.cls + '">' + esc(Lang.t(s.key)) + '</span>' +
                '<span style="' + this._mono + 'font-size:13px;font-weight:600;color:' +
                  s.color + ';">' + esc((e && e.symbol) || '') + '</span>' +
                '<span style="flex:1 1 260px;min-width:0;font-size:14px;line-height:1.45;">' +
                  esc((e && e.title) || '') + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(this._dateTime(e && e.ts)) + '</span>' +
                link +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.news_title'), Lang.t('paper.news_hint')) +
            '<div class="row-list" style="max-height:340px;overflow:auto;">' + feed + '</div>');
    },

    _statCards() {
        const p = this._p;
        const pnl = this._pnlTotal();
        const fees = this._feesTotal();
        const tv = this._totalValue();
        // La devise passe par '.unit' (composant existant : 16 px, --text-dim)
        // — collée au nombre en 30 px, elle repoussait la valeur sur 2 lignes.
        const cell = (labelKey, value, valueColor, footer) =>
            '<div class="stat-card">' +
              '<div class="label">' + esc(Lang.t(labelKey)) + '</div>' +
              '<div class="value"' + (valueColor ? ' style="color:' + valueColor + ';"' : '') + '>' +
                esc(value) + '<span class="unit">CHF</span></div>' +
              (footer ? '<div class="footer">' + footer + '</div>' : '') +
            '</div>';
        const pnlFooter = (pnl.pct === null)
            ? ''
            : '<span style="' + this._mono + 'color:' + this._color(pnl.pct) + ';">' +
              esc(this._signed(pnl.pct, 2, '%')) + '</span>';
        return '<div class="bento-overview" style="grid-template-columns:repeat(5,1fr);' +
                    'grid-template-rows:auto;margin-bottom:14px;">' +
            cell('paper.cash', this._num(p.cash), '', '') +
            cell('paper.total_value', this._num(tv), '', '') +
            cell('paper.pnl_total', this._signed(pnl.chf, 2, ''), this._color(pnl.chf), pnlFooter) +
            cell('paper.fees_total', this._num(fees), '', '') +
            this._afcCard() +
        '</div>';
    },

    // Garde-fou fiscal suisse : l'utilisateur voit EN DIRECT s'il sortirait du
    // statut d'investisseur privé — la leçon la plus chère qu'on puisse ignorer.
    _afcCard() {
        const afc = this._p ? this._p.afc : {};
        const status = String(this._pickField(afc, ['status', 'state']) || '');
        const ratio = this._n(this._pickField(afc, ['volume_ratio', 'ratio', 'volume_x']));
        const atRisk = (status === 'a_risque' || status === 'at_risk');
        const badge = atRisk
            ? '<span class="badge warn">' + esc(Lang.t('paper.afc_at_risk')) + '</span>'
            : '<span class="badge online">' + esc(Lang.t('paper.afc_private')) + '</span>';
        const footer = (ratio === null)
            ? ''
            : '<span style="' + this._mono + '">' + esc(Lang.t('paper.afc_volume')) + ' ' +
              esc(this._num(ratio, 2)) + '×</span>';
        return '<div class="stat-card">' +
            '<div class="label">' + esc(Lang.t('paper.afc_status')) + '</div>' +
            '<div style="margin-top:6px;">' + badge + '</div>' +
            (footer ? '<div class="footer">' + footer + '</div>' : '') +
        '</div>';
    },

    _equityCard() {
        const vals = this._p ? this._p.equity : [];
        if (!vals || vals.length < 2) {
            return this._card(this._head(Lang.t('paper.equity_title')) +
                this._muted(Lang.t('paper.equity_empty')));
        }
        const neg = vals[vals.length - 1] < vals[0];
        return this._card(
            this._head(Lang.t('paper.equity_title'),
                this._num(vals.length, 0) + ' ' + Lang.t('paper.equity_points')) +
            '<svg class="paper-spark' + (neg ? ' neg' : '') + '" id="paper-equity" ' +
                 'viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">' +
              '<polygon class="area" points=""></polygon>' +
              '<polyline points=""></polyline>' +
              '<circle class="tip" r="3"></circle>' +
            '</svg>' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;' +
                 'color:var(--text-dim);' + this._mono + '">' +
              '<span>' + esc(this._chf(vals[0])) + '</span>' +
              '<span>' + esc(this._chf(vals[vals.length - 1])) + '</span>' +
            '</div>'
        );
    },

    // Même mécanisme que la sparkline CPU du Dashboard (Anim.sparkline pose les
    // points sur un <svg> préparé). Repli maison si anim.js n'est pas chargé —
    // aucune bibliothèque, aucun CDN.
    _paintEquity() {
        const svg = document.getElementById('paper-equity');
        const vals = this._p ? this._p.equity : [];
        if (!svg || !vals || vals.length < 2) return;
        if (typeof Anim !== 'undefined' && Anim.sparkline) { Anim.sparkline(svg, vals); return; }
        const W = 600, H = 120;
        let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        if (max - min < 1e-9) { const mid = (max + min) / 2; min = mid - 1; max = mid + 1; }
        const step = W / (vals.length - 1);
        const pts = vals.map((v, i) => {
            const y = H - ((v - min) / (max - min)) * (H - 8) - 4;
            return (i * step).toFixed(1) + ',' + y.toFixed(1);
        });
        const line = pts.join(' ');
        const poly = svg.querySelector('polyline');
        const area = svg.querySelector('.area');
        const tip = svg.querySelector('.tip');
        if (poly) poly.setAttribute('points', line);
        if (area) area.setAttribute('points', '0,' + H + ' ' + line + ' ' + W + ',' + H);
        if (tip) {
            const last = pts[pts.length - 1].split(',');
            tip.setAttribute('cx', last[0]);
            tip.setAttribute('cy', last[1]);
        }
    },

    _positionsCard() {
        const rows = this._p.positions;
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.positions_title')) +
                this._muted(Lang.t('paper.positions_empty')));
        }
        const td = this._td();
        const body = rows.map((pos) => {
            const sym = String(pos.symbol || '');
            const qty = this._n(pos.qty);
            const avg = this._n(this._pickField(pos, ['avg_price', 'entry_price']));
            const last = this._n(this._pickField(pos, ['last_price', 'price', 'last']));
            const pnl = this._n(this._pickField(pos, ['pnl_chf', 'unrealized_pnl_chf', 'pnl']));
            const pnlPct = this._n(this._pickField(pos, ['pnl_pct', 'unrealized_pnl_pct']));
            const cur = pos.currency || '';
            return '<tr>' +
                '<td style="' + td + '">' +
                  '<span style="font-weight:600;">' + esc(sym) + '</span>' +
                  '<span style="font-size:12px;color:var(--text-dim);margin-left:6px;">' +
                    esc(this._sideLabel(pos.side || 'long')) + '</span>' +
                '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._num(qty, 0)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._money(avg, cur)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._money(last, cur)) + '</td>' +
                '<td style="' + td + this._mono + 'color:' + this._color(pnl) + ';">' +
                  esc(this._signedChf(pnl)) +
                  (pnlPct === null ? '' : '<span style="font-size:12px;margin-left:6px;">' +
                    esc(this._signed(pnlPct, 2, '%')) + '</span>') +
                '</td>' +
                '<td style="' + td + '">' +
                  '<button class="btn btn-sm" data-paper-act="close-pos" data-sym="' + esc(sym) + '">' +
                    esc(Lang.t('paper.close_position')) + '</button>' +
                '</td>' +
            '</tr>';
        }).join('');
        return this._card(this._head(Lang.t('paper.positions_title')) +
            this._table([
                Lang.t('paper.col_symbol'), Lang.t('paper.col_qty'), Lang.t('paper.col_avg_price'),
                Lang.t('paper.col_last'), Lang.t('paper.col_pnl'), Lang.t('paper.col_actions'),
            ], body));
    },

    _ordersCard() {
        const rows = this._p.orders;
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.orders_title')) +
                this._muted(Lang.t('paper.orders_empty')));
        }
        const td = this._td();
        const body = rows.map((o) => {
            const id = String(this._pickField(o, ['id', 'order_id']) || '');
            const price = this._n(this._pickField(o, ['limit_price', 'stop_price']));
            return '<tr>' +
                '<td style="' + td + 'font-weight:600;">' + esc(o.symbol || '') + '</td>' +
                '<td style="' + td + '">' + esc(this._sideLabel(o.side)) + '</td>' +
                '<td style="' + td + '">' + esc(this._kindLabel(o.kind)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._num(this._n(o.qty), 0)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._num(price, 2)) + '</td>' +
                '<td style="' + td + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                  esc(this._dateTime(o.created_at)) + '</td>' +
                '<td style="' + td + '">' +
                  (id ? '<button class="btn btn-sm" data-paper-act="cancel-order" data-id="' + esc(id) + '">' +
                    esc(Lang.t('paper.cancel_order')) + '</button>' : '') +
                '</td>' +
            '</tr>';
        }).join('');
        return this._card(this._head(Lang.t('paper.orders_title')) +
            this._table([
                Lang.t('paper.col_symbol'), Lang.t('paper.col_side'), Lang.t('paper.col_kind'),
                Lang.t('paper.col_qty'), Lang.t('paper.col_price'), Lang.t('paper.col_created'),
                Lang.t('paper.col_actions'),
            ], body));
    },

    async closePosition(symbol) {
        if (!symbol) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/positions/' + encodeURIComponent(symbol) + '/close',
                { method: 'POST', body: JSON.stringify({}) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.closed_ok') + ' ' + symbol);
        await this._loadPortfolio();
        this._renderBody();
    },

    async cancelOrder(id) {
        if (!id) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/orders/' + encodeURIComponent(id) + '/cancel',
                { method: 'POST', body: JSON.stringify({}) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.cancelled_ok'));
        await this._loadPortfolio();
        this._renderBody();
    },

    // =====================================================================
    //  2. NOUVEAU TRADE
    // =====================================================================

    _viewTrade() {
        return this._searchCard() + this._orderCard();
    },

    _searchCard() {
        const q = this._form.q || '';
        let results = '';
        if (this._results === null) {
            results = '';
        } else if (!this._results.length) {
            results = this._muted(Lang.t('paper.search_empty'));
        } else {
            results = '<div class="row-list" style="margin-top:10px;">' + this._results.map((x) => {
                const sym = String(x.symbol || '');
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;cursor:pointer;" ' +
                       'data-paper-act="pick" data-sym="' + esc(sym) + '" ' +
                       'data-name="' + esc(x.name || '') + '" ' +
                       'data-cur="' + esc(x.currency || '') + '" ' +
                       'data-exch="' + esc(x.exchange || '') + '">' +
                    '<div style="flex:1 1 220px;min-width:0;">' +
                      '<div style="font-size:15px;">' + esc(x.name || sym) + '</div>' +
                      '<div style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                        esc(sym) + (x.exchange ? ' · ' + esc(String(x.exchange)) : '') +
                        (x.currency ? ' · ' + esc(String(x.currency)) : '') + '</div>' +
                    '</div>' +
                    '<span class="badge">' + esc(Lang.t('paper.pick')) + '</span>' +
                '</div>';
            }).join('') + '</div>';
        }
        return this._card(
            this._head(Lang.t('paper.search_label'), Lang.t('paper.search_hint')) +
            '<input id="paper-q" class="form-input" autocomplete="off" ' +
                 'placeholder="' + esc(Lang.t('paper.search_placeholder')) + '" ' +
                 'value="' + esc(q) + '" />' +
            results
        );
    },

    _orderCard() {
        if (!this._pick) return this._card(this._muted(Lang.t('paper.pick_first')));
        const f = this._form;
        const cur = this._pick.currency || '';
        const kind = f.kind || 'market';
        const side = f.side || 'buy';
        const feeProfile = f.fee_profile || (this._p && this._p.fee_profile) || 'yuh';
        const opt = (val, labelKey, sel) =>
            '<option value="' + esc(val) + '"' + (sel === val ? ' selected' : '') + '>' +
            esc(Lang.t(labelKey)) + '</option>';
        // max-width : sans lui, le dernier champ d'une ligne qui se replie
        // s'étire sur toute la largeur (vu à l'écran sur « Profil de frais »).
        const field = (labelKey, inner, flex) =>
            '<div style="flex:1 1 ' + (flex || '150px') + ';min-width:0;max-width:260px;">' +
              '<label class="form-label">' + esc(Lang.t(labelKey)) + '</label>' + inner + '</div>';
        const numInput = (id, val, ph) =>
            '<input id="' + id + '" class="form-input" type="number" step="any" data-paper-size="1" ' +
            'value="' + esc(val === undefined || val === null ? '' : val) + '" ' +
            'placeholder="' + esc(ph || '') + '" />';

        const quoteLine = this._quote
            ? '<div style="font-size:13px;color:var(--text-muted);' + this._mono + 'margin-bottom:10px;">' +
              esc(Lang.t('paper.last_price')) + ' ' +
              esc(this._money(this._quote.price, this._quote.currency || cur)) +
              (this._n(this._quote.change_pct) === null ? '' :
                ' <span style="color:' + this._color(this._quote.change_pct) + ';">' +
                esc(this._signed(this._quote.change_pct, 2, '%')) + '</span>') +
              '</div>'
            : '';

        return this._card(
            this._head(Lang.t('paper.order_title'),
                this._pick.symbol + (this._pick.name ? ' — ' + this._pick.name : '')) +
            quoteLine +
            '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
              field('paper.form_side',
                '<select id="paper-side" class="form-input" data-paper-size="1">' +
                  opt('buy', 'paper.side_buy', side) + opt('sell', 'paper.side_sell', side) +
                  opt('short', 'paper.side_short', side) + opt('cover', 'paper.side_cover', side) +
                '</select>') +
              field('paper.form_kind',
                '<select id="paper-kind" class="form-input" data-paper-size="1">' +
                  opt('market', 'paper.kind_market', kind) + opt('limit', 'paper.kind_limit', kind) +
                  opt('stop', 'paper.kind_stop', kind) +
                '</select>') +
              field('paper.form_qty', numInput('paper-qty', f.qty, '')) +
              (kind === 'limit' ? field('paper.form_limit_price', numInput('paper-limit', f.limit_price, '')) : '') +
              (kind === 'stop' ? field('paper.form_stop_price', numInput('paper-stop', f.stop_price, '')) : '') +
              field('paper.form_stop_loss', numInput('paper-sl', f.stop_loss, '')) +
              field('paper.form_target', numInput('paper-target', f.target, '')) +
              field('paper.form_fee_profile',
                '<select id="paper-feeprofile" class="form-input">' +
                  opt('yuh', 'paper.fee_yuh', feeProfile) +
                  opt('swissquote', 'paper.fee_swissquote', feeProfile) +
                  opt('ibkr', 'paper.fee_ibkr', feeProfile) +
                '</select>') +
            '</div>' +
            '<div style="margin-top:12px;">' +
              '<label class="form-label">' + esc(Lang.t('paper.form_thesis')) + '</label>' +
              '<textarea id="paper-thesis" class="form-input" rows="4" ' +
                   'style="resize:vertical;line-height:1.5;" ' +
                   'placeholder="' + esc(Lang.t('paper.form_thesis_ph')) + '">' +
                esc(f.thesis || '') + '</textarea>' +
            '</div>' +
            // Aide au dimensionnement : la seule chose que le coach ne négocie pas.
            '<div id="paper-sizing" style="margin-top:10px;font-size:13px;' + this._mono +
                 'color:var(--text-muted);">' + esc(this._sizingText()) + '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
              '<button class="btn btn-primary" data-paper-act="submit-order">' +
                esc(Lang.t('paper.submit_order')) + '</button>' +
            '</div>'
        );
    },

    // Lit le formulaire tel qu'il est À L'ÉCRAN (le re-rendu du corps ne doit
    // jamais avaler ce qui a été tapé).
    _captureForm() {
        const val = (id) => {
            const el = document.getElementById(id);
            return el ? el.value : undefined;
        };
        const f = this._form;
        const q = val('paper-q'); if (q !== undefined) f.q = q;
        const side = val('paper-side'); if (side !== undefined) f.side = side;
        const kind = val('paper-kind'); if (kind !== undefined) f.kind = kind;
        const qty = val('paper-qty'); if (qty !== undefined) f.qty = qty;
        const lim = val('paper-limit'); if (lim !== undefined) f.limit_price = lim;
        const stp = val('paper-stop'); if (stp !== undefined) f.stop_price = stp;
        const sl = val('paper-sl'); if (sl !== undefined) f.stop_loss = sl;
        const tg = val('paper-target'); if (tg !== undefined) f.target = tg;
        const th = val('paper-thesis'); if (th !== undefined) f.thesis = th;
        const fp = val('paper-feeprofile'); if (fp !== undefined) f.fee_profile = fp;
    },

    // Prix d'entrée retenu pour le calcul : le prix POSÉ (limite/stop) prime sur
    // le dernier cours — c'est le prix auquel on entrera vraiment.
    _entryPrice() {
        const f = this._form;
        const kind = f.kind || 'market';
        if (kind === 'limit') {
            const v = this._n(f.limit_price);
            if (v !== null) return v;
        }
        if (kind === 'stop') {
            const v = this._n(f.stop_price);
            if (v !== null) return v;
        }
        return this._quote ? this._n(this._quote.price) : null;
    },

    _sizingText() {
        const cap = this._capital();
        const entry = this._entryPrice();
        const stop = this._n(this._form.stop_loss);
        if (cap === null || entry === null || stop === null || entry === stop) {
            return Lang.t('paper.sizing_need_stop');
        }
        const fx = (this._quote && this._n(this._quote.fx_rate_chf)) || 1;
        const perShare = Math.abs(entry - stop) * fx;
        if (!(perShare > 0)) return Lang.t('paper.sizing_need_stop');
        const line = (pct) => {
            const risk = cap * pct / 100;
            const n = Math.floor(risk / perShare);
            return this._num(pct, 0) + ' % (' + this._chf(risk) + ') : ' +
                this._num(n, 0) + ' ' + Lang.t('paper.sizing_shares');
        };
        return Lang.t('paper.sizing_risk') + ' ' + line(1) + '  ·  ' + line(2);
    },

    _paintSizing() {
        const el = document.getElementById('paper-sizing');
        if (el) el.textContent = this._sizingText();
    },

    async search(q) {
        const term = String(q || '').trim();
        if (term.length < 2) { this._results = null; this._redrawSearch(); return; }
        const d = await this._get('/api/paper/search?q=' + encodeURIComponent(term));
        const rows = Array.isArray(d) ? d : ((d && Array.isArray(d.results)) ? d.results : []);
        this._results = rows;
        this._redrawSearch();
    },

    // Redessine la LISTE seulement : on ne touche pas au champ de saisie, le
    // curseur de l'utilisateur y est.
    _redrawSearch() {
        if (this._tab !== 'trade') return;
        this._captureForm();
        this._renderBody();
        const el = document.getElementById('paper-q');
        if (el) {
            const v = el.value;
            el.focus();
            try { el.setSelectionRange(v.length, v.length); } catch (e) { /* type non supporté */ }
        }
    },

    async pick(symbol, name, currency, exchange) {
        if (!symbol) return;
        this._captureForm();
        this._pick = { symbol: symbol, name: name || '', currency: currency || '', exchange: exchange || '' };
        this._results = null;
        this._quote = null;
        this._renderBody();
        const d = await this._get('/api/paper/quotes?symbols=' + encodeURIComponent(symbol));
        const q = (d && typeof d === 'object') ? (d[symbol] || d[String(symbol).toUpperCase()] || null) : null;
        if (q && typeof q === 'object') this._quote = q;
        if (this._tab === 'trade') { this._captureForm(); this._renderBody(); }
    },

    async submitOrder() {
        this._captureForm();
        if (!this._pick || !this._pick.symbol) { this._toast('warn', Lang.t('paper.symbol_required')); return; }
        const qty = this._n(this._form.qty);
        if (qty === null || qty <= 0) { this._toast('warn', Lang.t('paper.qty_required')); return; }
        const kind = this._form.kind || 'market';
        const body = {
            symbol: this._pick.symbol,
            side: this._form.side || 'buy',
            kind: kind,
            qty: qty,
            thesis: String(this._form.thesis || ''),
            fee_profile: this._form.fee_profile || undefined,
        };
        if (kind === 'limit') body.limit_price = this._n(this._form.limit_price);
        if (kind === 'stop') body.stop_price = this._n(this._form.stop_price);
        const sl = this._n(this._form.stop_loss);
        if (sl !== null) body.stop_loss = sl;
        const tg = this._n(this._form.target);
        if (tg !== null) body.target = tg;

        let r = null;
        try { r = await Auth.apiCall('/api/paper/orders', { method: 'POST', body: JSON.stringify(body) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        // Les avertissements du backend (thèse vide, pas de stop, risque > 2 %)
        // sont affichés — on AVERTIT, on ne bloque JAMAIS.
        const warnings = (d && Array.isArray(d.warnings)) ? d.warnings : [];
        warnings.forEach((w) => {
            const txt = (w && typeof w === 'object') ? (w.message || w.detail || w.code || '') : w;
            if (txt) this._toast('warn', String(txt));
        });
        this._toast('success', Lang.t('paper.order_ok'));
        // Le titre choisi reste sélectionné (on enchaîne souvent), la saisie part.
        const keepQ = this._form.q;
        this._form = { q: keepQ, side: this._form.side, kind: this._form.kind,
            fee_profile: this._form.fee_profile };
        await this._loadPortfolio();
        if (this._tab === 'trade') this._renderBody();
    },

    // =====================================================================
    //  3. JOURNAL
    // =====================================================================

    _viewJournal() {
        if (!this._p) return this._card(this._muted(Lang.t('paper.no_data')));
        const trades = this._p.trades;
        if (!trades.length) {
            return this._card(this._head(Lang.t('paper.journal_title')) +
                this._muted(Lang.t('paper.journal_empty')));
        }
        const td = this._td();
        // Le plus récent en tête : on relit ce qu'on vient de faire.
        const idx = trades.map((t, i) => i).reverse();
        const body = idx.map((i) => {
            const t = trades[i] || {};
            const r = this._n(t.r_multiple);
            const pnl = this._n(t.pnl_chf);
            const fees = (this._n(t.fees_chf) || 0) + (this._n(t.stamp_duty_chf) || 0);
            const selected = (this._tradeIdx === i);
            return '<tr data-paper-act="open-trade" data-idx="' + esc(String(i)) + '" ' +
                   'style="cursor:pointer;' + (selected ? 'background:var(--bg-elev-2);' : '') + '">' +
                '<td style="' + td + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                  esc(this._date(t.exit_at)) + '</td>' +
                '<td style="' + td + 'font-weight:600;">' + esc(t.symbol || '') + '</td>' +
                '<td style="' + td + '">' + esc(this._sideLabel(t.side)) + '</td>' +
                '<td style="' + td + this._mono + 'font-weight:600;color:' + this._color(r) + ';">' +
                  esc(r === null ? '—' : this._signed(r, 2, ' R')) + '</td>' +
                '<td style="' + td + this._mono + 'color:' + this._color(pnl) + ';">' +
                  esc(this._signedChf(pnl)) + '</td>' +
                '<td style="' + td + this._mono + 'color:var(--text-muted);">' +
                  esc(this._chf(fees)) + '</td>' +
                '<td style="' + td + 'font-size:13px;color:var(--text-muted);">' +
                  esc(t.exit_reason || '') + '</td>' +
            '</tr>';
        }).join('');
        return this._card(this._head(Lang.t('paper.journal_title'),
                Lang.t('paper.journal_hint')) +
            this._table([
                Lang.t('paper.col_date'), Lang.t('paper.col_symbol'), Lang.t('paper.col_side'),
                Lang.t('paper.col_r'), Lang.t('paper.col_pnl'), Lang.t('paper.col_fees'),
                Lang.t('paper.col_exit_reason'),
            ], body)) + this._tradeDetail();
    },

    _tradeDetail() {
        if (this._tradeIdx === null || !this._p) return '';
        const t = this._p.trades[this._tradeIdx];
        if (!t) return '';
        const cur = t.currency || '';
        const line = (labelKey, value) =>
            '<div style="display:flex;gap:10px;align-items:baseline;">' +
              '<span style="font-size:12px;color:var(--text-dim);min-width:150px;">' +
                esc(Lang.t(labelKey)) + '</span>' +
              '<span style="font-size:14px;' + this._mono + '">' + esc(value) + '</span>' +
            '</div>';
        return this._card(
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
              '<h3 style="margin:0;font-size:17px;">' + esc(Lang.t('paper.detail_title')) + ' — ' +
                esc(t.symbol || '') + '</h3>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="close-trade" ' +
                      'style="margin-left:auto;">' + esc(Lang.t('paper.close')) + '</button>' +
            '</div>' +
            '<div style="display:grid;gap:4px;">' +
              line('paper.entry', this._money(t.entry_price, cur) + '  ' + this._dateTime(t.entry_at)) +
              line('paper.exit', this._money(t.exit_price, cur) + '  ' + this._dateTime(t.exit_at)) +
              line('paper.planned_stop', this._num(this._n(t.planned_stop), 2)) +
              line('paper.col_qty', this._num(this._n(t.qty), 0)) +
              line('paper.col_r', this._n(t.r_multiple) === null ? '—' : this._signed(t.r_multiple, 2, ' R')) +
              line('paper.col_pnl', this._signedChf(this._n(t.pnl_chf)) +
                (this._n(t.pnl_pct) === null ? '' : '  ' + this._signed(t.pnl_pct, 2, '%'))) +
              line('paper.col_fees', this._chf((this._n(t.fees_chf) || 0) + (this._n(t.stamp_duty_chf) || 0))) +
              line('paper.col_exit_reason', t.exit_reason || '—') +
            '</div>' +
            this._sub('paper.thesis_label') +
            '<div style="font-size:14px;line-height:1.6;background:var(--bg-elev-3);' +
                 'padding:10px 12px;border-radius:var(--r-md);white-space:pre-wrap;">' +
              esc(t.thesis ? String(t.thesis) : Lang.t('paper.thesis_empty')) +
            '</div>' +
            '<div style="margin-top:12px;">' +
              '<button class="btn btn-primary" data-paper-act="postmortem" ' +
                      'data-idx="' + esc(String(this._tradeIdx)) + '">' +
                esc(Lang.t('paper.postmortem')) + '</button>' +
            '</div>' +
            (this._postmortem ? this._panel(Lang.t('paper.postmortem_title'), this._postmortem) : '')
        );
    },

    // =====================================================================
    //  4. COACH
    // =====================================================================

    _viewCoach() {
        if (!this._coach) return this._card(this._muted(Lang.t('paper.loading')));
        return this._biasesCard() + this._summaryCard() + this._askCard() +
            this._analysisCard() + this._notesCard();
    },

    _biasList() {
        const c = this._coach || {};
        if (Array.isArray(c.biases)) return c.biases;
        if (Array.isArray(c)) return c;
        if (this._p && Array.isArray(this._p.biases)) return this._p.biases;
        return [];
    },

    _biasesCard() {
        const rows = this._biasList();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.biases_title')) +
                this._muted(Lang.t('paper.biases_empty')));
        }
        const cards = rows.map((b) => {
            const code = String((b && b.code) || '');
            const sev = String((b && b.severity) || '');
            const critical = (sev === 'critical' || sev === 'crit');
            const borderColor = critical ? 'var(--danger)' : 'var(--warning)';
            const sevLabel = critical ? Lang.t('paper.severity_critical') : Lang.t('paper.severity_warn');
            const ev = (b && Array.isArray(b.evidence)) ? b.evidence : [];
            const evHtml = ev.length
                ? '<div style="margin-top:8px;">' +
                  '<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">' +
                    esc(Lang.t('paper.evidence')) + '</div>' +
                  '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;">' +
                    ev.map((e) => {
                        const txt = (e && typeof e === 'object')
                            ? (e.text || e.message || e.symbol || JSON.stringify(e)) : e;
                        return '<li>' + esc(String(txt)) + '</li>';
                    }).join('') +
                  '</ul></div>'
                : '';
            const desc = (b && (b.message || b.detail || b.description)) || '';
            return '<div style="border:1px solid ' + borderColor + ';border-radius:var(--r-md);' +
                        'padding:12px 14px;margin-bottom:10px;">' +
                '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
                  '<span style="font-size:15px;font-weight:600;">' + esc(this._biasLabel(code)) + '</span>' +
                  '<span class="badge ' + (critical ? 'danger' : 'warn') + '">' + esc(sevLabel) + '</span>' +
                  '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                    esc(code) + '</span>' +
                '</div>' +
                (desc ? '<div style="font-size:14px;line-height:1.55;margin-top:6px;">' +
                    esc(String(desc)) + '</div>' : '') +
                evHtml +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.biases_title'), Lang.t('paper.biases_hint')) + cards);
    },

    _summaryCard() {
        const c = this._coach || {};
        const s = this._pickField(c, ['coach_summary', 'summary', 'profile']);
        if (!s) return '';
        if (typeof s === 'string') {
            return this._card(this._head(Lang.t('paper.profile_title')) + this._panel('', s));
        }
        const listOf = (v) => {
            if (Array.isArray(v)) return v;
            if (v === null || v === undefined || v === '') return [];
            return [v];
        };
        const block = (labelKey, items) => {
            const rows = listOf(items);
            if (!rows.length) return '';
            return this._sub(labelKey) +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                rows.map((x) => {
                    const txt = (x && typeof x === 'object')
                        ? (x.label || x.code || x.title || x.text || JSON.stringify(x)) : x;
                    const isCode = (x && typeof x === 'object' && x.code) ? x.code : null;
                    return '<span class="badge">' +
                        esc(isCode ? this._biasLabel(isCode) : String(txt)) + '</span>';
                }).join('') + '</div>';
        };
        const inner =
            block('paper.top_biases', this._pickField(s, ['top_biases', 'top', 'biases'])) +
            block('paper.recent_progress', this._pickField(s, ['recent_progress', 'progress'])) +
            block('paper.milestones', this._pickField(s, ['milestones', 'achievements']));
        const note = this._pickField(s, ['note', 'text', 'summary']);
        if (!inner && !note) return '';
        return this._card(this._head(Lang.t('paper.profile_title')) + inner +
            (note ? this._panel('', String(note)) : ''));
    },

    _askCard() {
        return this._card(
            this._head(Lang.t('paper.ask_title'), Lang.t('paper.ask_hint')) +
            '<textarea id="paper-question" class="form-input" rows="3" ' +
                 'style="resize:vertical;line-height:1.5;" ' +
                 'placeholder="' + esc(Lang.t('paper.ask_placeholder')) + '"></textarea>' +
            '<div style="margin-top:10px;">' +
              '<button class="btn btn-primary" data-paper-act="ask">' +
                esc(Lang.t('paper.ask_send')) + '</button>' +
            '</div>' +
            (this._answer ? this._panel(Lang.t('paper.answer_title'), this._answer) : '')
        );
    },

    _analysisCard() {
        return this._card(
            this._head(Lang.t('paper.analysis_title'), Lang.t('paper.analysis_hint')) +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
              '<div style="flex:0 1 220px;">' +
                '<label class="form-label">' + esc(Lang.t('paper.col_symbol')) + '</label>' +
                '<input id="paper-analysis-sym" class="form-input" autocomplete="off" ' +
                     'placeholder="' + esc(Lang.t('paper.analysis_symbol_ph')) + '" />' +
              '</div>' +
              '<button class="btn btn-primary" data-paper-act="analysis">' +
                esc(Lang.t('paper.analysis_btn')) + '</button>' +
            '</div>' +
            (this._analysis ? this._panel(Lang.t('paper.analysis_title'), this._analysis) : '')
        );
    },

    // --- Carnet : le coach écrit une mémoire LISIBLE (Markdown brut) ---------
    //
    // Rendu volontairement brut : pas de moteur Markdown (aucune dépendance),
    // et surtout aucun HTML issu d'un texte que le LLM a écrit. Le bloc mono
    // Le bloc mono .console du design system fait exactement ce qu'il faut (pre-wrap,
    // fond bleu-nuit invariant au mode clair).

    _notesCard() {
        const rows = this._noteList();
        const list = rows.length
            ? '<div class="row-list">' + rows.map((n) => {
                const name = String((n && n.name) || '');
                const size = this._n(n && n.size);
                const active = (this._noteName === name);
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;cursor:pointer;' +
                       (active ? 'border-color:var(--accent);' : '') + '" ' +
                       'data-paper-act="open-note" data-note="' + esc(name) + '">' +
                    '<span style="flex:1 1 220px;min-width:0;font-size:14px;' + this._mono + '">' +
                      esc(name) + '</span>' +
                    '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                      esc(this._dateTime(n && n.modified)) +
                      (size === null ? '' : ' · ' + esc(this._num(size, 0)) + ' o') +
                    '</span>' +
                '</div>';
            }).join('') + '</div>'
            : this._muted(Lang.t('paper.notes_empty'));
        const body = (this._noteName && this._noteBody !== null)
            ? '<div style="margin-top:12px;">' +
                '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;">' +
                  '<span style="font-size:13px;' + this._mono + 'color:var(--text-muted);">' +
                    esc(this._noteName) + '</span>' +
                  '<button class="btn btn-ghost btn-sm" data-paper-act="close-note" ' +
                          'style="margin-left:auto;">' + esc(Lang.t('paper.close')) + '</button>' +
                '</div>' +
                '<pre class="console" style="margin:0;">' + esc(this._noteBody) + '</pre>' +
              '</div>'
            : '';
        return this._card(this._head(Lang.t('paper.notes_title'), Lang.t('paper.notes_hint')) +
            list + body);
    },

    _noteList() {
        const n = this._notes;
        if (Array.isArray(n)) return n;
        if (n && Array.isArray(n.notes)) return n.notes;
        return [];
    },

    // Le nom peut contenir des « / » (« Biais/revenge_trade.md ») : on encode
    // CHAQUE segment et on rejoint avec de vrais « / » — un %2F serait décodé
    // par le serveur ASGI avant le routage et ne matcherait plus la route.
    _noteUrl(name) {
        const parts = String(name || '').split('/').filter((s) => s !== '');
        return '/api/paper/coach/notes/' + parts.map(encodeURIComponent).join('/');
    },

    async openNote(name) {
        if (!name) return;
        if (this._noteName === name && this._noteBody !== null) {
            this._noteName = null; this._noteBody = null; this._renderBody(); return;
        }
        const d = await this._get(this._noteUrl(name));
        if (!d) { this._toast('error', Lang.t('paper.error')); return; }
        this._noteName = String(d.name || name);
        this._noteBody = String(this._pickField(d, ['markdown', 'content', 'text']) || '');
        this._renderBody();
    },

    // =====================================================================
    //  5. LEÇONS
    // =====================================================================

    _lessonList() {
        const l = this._lessons;
        if (Array.isArray(l)) return l;
        if (l && Array.isArray(l.lessons)) return l.lessons;
        if (l && Array.isArray(l.catalog)) return l.catalog;
        return [];
    },

    _viewLessons() {
        if (!this._lessons) return this._card(this._muted(Lang.t('paper.loading')));
        const rows = this._lessonList();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.lessons_title')) +
                this._muted(Lang.t('paper.lessons_empty')));
        }
        if (this._lessonId !== null) return this._lessonDetail();
        const list = '<div class="row-list">' + rows.map((l) => {
            const id = String(this._pickField(l, ['id', 'slug', 'key']) || '');
            const done = !!(l && (l.passed || l.done || l.completed));
            return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                   'flex-wrap:wrap;padding:10px 12px;cursor:pointer;" ' +
                   'data-paper-act="open-lesson" data-lesson="' + esc(id) + '">' +
                '<span style="flex:1 1 240px;min-width:0;font-size:15px;">' +
                  esc((l && l.title) || id) + '</span>' +
                '<span class="badge' + (done ? ' online' : '') + '">' +
                  esc(done ? Lang.t('paper.lesson_done') : Lang.t('paper.lesson_todo')) + '</span>' +
            '</div>';
        }).join('') + '</div>';
        return this._card(this._head(Lang.t('paper.lessons_title'), Lang.t('paper.lessons_hint')) + list);
    },

    _lesson(id) {
        const rows = this._lessonList();
        for (let i = 0; i < rows.length; i++) {
            const l = rows[i];
            const lid = String(this._pickField(l, ['id', 'slug', 'key']) || '');
            if (lid === String(id)) return l;
        }
        return null;
    },

    _lessonDetail() {
        const l = this._lesson(this._lessonId);
        if (!l) return this._card(this._muted(Lang.t('paper.no_data')));
        const raw = this._pickField(l, ['body', 'content', 'text', 'paragraphs']);
        let paras = [];
        if (Array.isArray(raw)) paras = raw;
        else if (typeof raw === 'string') paras = raw.split(/\n\s*\n/);
        const bodyHtml = paras.filter((x) => String(x).trim() !== '').map((x) =>
            '<p style="font-size:15px;line-height:1.7;margin:0 0 12px;">' + esc(String(x)) + '</p>'
        ).join('');
        return this._card(
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
              '<h3 style="margin:0;font-size:19px;">' + esc(l.title || this._lessonId) + '</h3>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="close-lesson" ' +
                      'style="margin-left:auto;">' + esc(Lang.t('paper.back_to_lessons')) + '</button>' +
            '</div>' +
            (bodyHtml || this._muted(Lang.t('paper.no_data'))) +
            this._quizHtml(l)
        );
    },

    _quizQuestions(l) {
        const q = this._pickField(l, ['quiz', 'questions']);
        if (Array.isArray(q)) return q;
        if (q && Array.isArray(q.questions)) return q.questions;
        return [];
    },

    _quizHtml(l) {
        const qs = this._quizQuestions(l);
        if (!qs.length) return '';
        const res = this._quizResult;
        const correct = (res && Array.isArray(res.correct)) ? res.correct : null;
        const blocks = qs.map((q, qi) => {
            const opts = (q && Array.isArray(q.options)) ? q.options
                : ((q && Array.isArray(q.answers)) ? q.answers : []);
            const good = (correct && correct.length > qi) ? Number(correct[qi]) : null;
            const optHtml = opts.map((o, oi) => {
                const isGood = (good !== null && good === oi);
                return '<label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;' +
                            'padding:5px 0;font-size:14px;line-height:1.5;' +
                            (isGood ? 'color:var(--accent);' : '') + '">' +
                    '<input type="radio" name="paper-q' + qi + '" class="paper-quiz" ' +
                         'data-q="' + qi + '" value="' + oi + '" ' +
                         (correct ? 'disabled ' : '') +
                         'style="margin-top:3px;accent-color:var(--accent);cursor:pointer;" />' +
                    '<span>' + esc(String(o)) + '</span>' +
                '</label>';
            }).join('');
            const expl = (q && (q.explanation || q.why)) ? String(q.explanation || q.why) : '';
            return '<div style="margin-bottom:14px;">' +
                '<div style="font-size:15px;font-weight:600;margin-bottom:6px;">' +
                  esc(String(this._pickField(q, ['question', 'text', 'title']) || '')) + '</div>' +
                optHtml +
                ((correct && expl)
                    ? '<div style="font-size:13px;color:var(--text-muted);margin-top:6px;' +
                           'line-height:1.55;">' + esc(expl) + '</div>'
                    : '') +
            '</div>';
        }).join('');
        let verdict = '';
        if (res) {
            const passed = !!res.passed;
            verdict = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">' +
                '<span class="badge ' + (passed ? 'online' : 'warn') + '">' +
                  esc(passed ? Lang.t('paper.quiz_passed') : Lang.t('paper.quiz_failed')) + '</span>' +
                '<span style="' + this._mono + 'font-size:14px;">' +
                  esc(Lang.t('paper.quiz_score') + ' ' + this._num(this._n(res.score), 0) +
                      ' / ' + this._num(qs.length, 0)) + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);">' +
                  esc(Lang.t('paper.quiz_correct_answer')) + '</span>' +
            '</div>';
        }
        return this._sub('paper.quiz_title') + blocks +
            (res ? verdict : '<button class="btn btn-primary" data-paper-act="quiz-submit" ' +
                'data-lesson="' + esc(String(this._lessonId)) + '">' +
                esc(Lang.t('paper.quiz_submit')) + '</button>');
    },

    async submitQuiz(id) {
        const l = this._lesson(id);
        if (!l) return;
        const qs = this._quizQuestions(l);
        const answers = new Array(qs.length).fill(-1);
        document.querySelectorAll('#paper-body .paper-quiz').forEach((el) => {
            if (!el.checked) return;
            const qi = parseInt(el.getAttribute('data-q'), 10);
            const oi = parseInt(el.value, 10);
            if (isFinite(qi) && isFinite(oi) && qi >= 0 && qi < answers.length) answers[qi] = oi;
        });
        if (answers.indexOf(-1) >= 0) { this._toast('warn', Lang.t('paper.quiz_answer_all')); return; }
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/lessons/' + encodeURIComponent(String(id)) + '/quiz',
                { method: 'POST', body: JSON.stringify({ answers: answers }) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        this._quizResult = d || {};
        this._toast(this._quizResult.passed ? 'success' : 'warn',
            this._quizResult.passed ? Lang.t('paper.quiz_passed') : Lang.t('paper.quiz_failed'));
        // La progression vit dans le profil coach : on relit le catalogue.
        this._lessons = await this._get('/api/paper/lessons') || this._lessons;
        if (this._tab === 'lessons') this._renderBody();
    },

    // =====================================================================
    //  6. ARÈNE
    // =====================================================================

    _viewArena() {
        if (!this._arena) return this._card(this._muted(Lang.t('paper.loading')));
        const a = this._arena;
        const ch = this._pickField(a, ['challenge', 'current', 'week']);
        const hist = (a && Array.isArray(a.history)) ? a.history : [];
        let head = '';
        if (!ch || typeof ch !== 'object') {
            head = this._card(this._head(Lang.t('paper.arena_title')) +
                this._muted(Lang.t('paper.arena_none')));
        } else {
            const accepted = !!(a.accepted || ch.accepted);
            const diff = this._pickField(ch, ['difficulty', 'level']);
            head = this._card(
                this._head(Lang.t('paper.arena_title'), Lang.t('paper.arena_hint')) +
                '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
                  '<span style="font-size:18px;font-weight:600;">' +
                    esc(this._pickField(ch, ['title', 'name']) || '') + '</span>' +
                  (diff ? '<span class="badge warn">' + esc(Lang.t('paper.arena_difficulty')) +
                      ' ' + esc(String(diff)) + '</span>' : '') +
                  (accepted ? '<span class="badge online">' +
                      esc(Lang.t('paper.arena_accepted')) + '</span>' : '') +
                '</div>' +
                '<div style="font-size:15px;line-height:1.65;margin-top:8px;">' +
                  esc(this._pickField(ch, ['description', 'desc', 'text']) || '') + '</div>' +
                (accepted ? '' :
                  '<div style="margin-top:12px;">' +
                    '<button class="btn btn-primary" data-paper-act="arena-accept">' +
                      esc(Lang.t('paper.arena_accept')) + '</button>' +
                  '</div>')
            );
        }
        const histHtml = hist.length
            ? '<div class="row-list">' + hist.map((h) => {
                const r = this._n(this._pickField(h, ['r_multiple', 'result_r']));
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;">' +
                    '<span style="flex:1 1 220px;min-width:0;font-size:14px;">' +
                      esc(this._pickField(h, ['title', 'name', 'challenge']) || '') + '</span>' +
                    '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                      esc(this._date(this._pickField(h, ['week', 'date', 'accepted_at']))) + '</span>' +
                    (r === null ? '' : '<span style="' + this._mono + 'color:' + this._color(r) + ';">' +
                      esc(this._signed(r, 2, ' R')) + '</span>') +
                '</div>';
            }).join('') + '</div>'
            : this._muted(Lang.t('paper.arena_empty'));
        return head + this._card(this._head(Lang.t('paper.arena_history')) + histHtml);
    },

    async acceptArena() {
        let r = null;
        try { r = await Auth.apiCall('/api/paper/arena/accept', { method: 'POST', body: JSON.stringify({}) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.arena_accepted'));
        this._arena = await this._get('/api/paper/arena') || this._arena;
        if (this._tab === 'arena') this._renderBody();
    },


    // --- Remise a zero -------------------------------------------------------
    //
    // Discret, en bas, en tonalite danger : c'est une action rare et definitive.
    // Le sous-texte dit ce qui SURVIT — sinon on n'ose jamais cliquer.
    _resetCard() {
        return this._card(
            '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
              '<div style="flex:1 1 320px;min-width:0;font-size:13px;color:var(--text-dim);' +
                   'line-height:1.5;">' + esc(Lang.t('paper.reset_hint')) + '</div>' +
              '<button class="btn btn-ghost" data-paper-act="reset" ' +
                      'style="color:var(--danger);border-color:var(--danger);">' +
                esc(Lang.t('paper.reset_btn')) + '</button>' +
            '</div>'
        );
    },

    async resetPortfolio() {
        // Double confirmation : une remise a zero efface des trades que le
        // journal ne pourra plus jamais rejouer.
        if (!window.confirm(Lang.t('paper.reset_confirm1'))) return;
        if (!window.confirm(Lang.t('paper.reset_confirm2'))) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/portfolio/reset',
                { method: 'POST', body: JSON.stringify({}) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.reset_ok'));
        // Le coach et le carnet survivent cote backend : on les relit plutot
        // que de les vider ici (leurs biais parlent des trades effaces).
        this._coach = null;
        this._tradeIdx = null;
        this._postmortem = null;
        await this._tickAndLoad();
        this._renderBody();
    },

    // =====================================================================
    //  7. GRANDS PORTEFEUILLES (13F)
    // =====================================================================

    // Valeur en dollars, abregee : « 267.4 Md$ ». Le separateur decimal reste
    // celui du reste du module (format suisse) — melanger « , » ici et « . »
    // ailleurs ferait douter d'un chiffre, ce qui est pire qu'inelegant.
    _usd(v) {
        const n = this._n(v);
        if (n === null) return '—';
        const a = Math.abs(n);
        if (a >= 1e9) return this._num(n / 1e9, 1) + ' ' + Lang.t('paper.unit_billion') + '$';
        if (a >= 1e6) return this._num(n / 1e6, 1) + ' ' + Lang.t('paper.unit_million') + '$';
        return this._num(n, 0) + ' $';
    },

    _whaleManagers() {
        const w = this._whales;
        if (Array.isArray(w)) return w;
        if (w && Array.isArray(w.managers)) return w.managers;
        return [];
    },

    _viewWhales() {
        if (!this._whales) return this._card(this._muted(Lang.t('paper.loading')));
        return this._whalesDisclaimer() + this._whalesManagersCard() +
            this._whalesSnapshot() + this._whalesEventsCard();
    },

    // Ligne d'honnetete PERMANENTE : un 13F est vieux de 45 jours et ne montre
    // que les actions US longues. La cacher rendrait la vue trompeuse.
    _whalesDisclaimer() {
        return '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
                    'background:var(--bg-elev-2);font-size:14px;line-height:1.5;">' +
            esc(Lang.t('paper.whales_disclaimer')) + '</div>';
    },

    _whalesManagersCard() {
        const rows = this._whaleManagers();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.whales_managers')) +
                this._muted(Lang.t('paper.whales_empty')));
        }
        const pills = rows.map((m) => {
            const id = String(this._pickField(m, ['id', 'key', 'slug']) || '');
            const active = (this._whaleId === id);
            return '<button class="paper-tab' + (active ? ' active' : '') + '" ' +
                   'data-paper-act="whale-pick" data-whale="' + esc(id) + '">' +
                esc((m && m.label) || id) +
                (m && m.quarter ? ' <span style="font-size:11px;opacity:.75;">' +
                    esc(String(m.quarter)) + '</span>' : '') +
                (m && m.cached ? ' <span style="font-size:11px;opacity:.75;">' +
                    esc(Lang.t('paper.whales_cached')) + '</span>' : '') +
            '</button>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_managers')) +
            '<div class="paper-tabs" style="margin-bottom:0;">' + pills + '</div>');
    },

    _whalesSnapshot() {
        if (this._whaleLoading) {
            return this._card(this._muted(Lang.t('paper.whales_loading')));
        }
        if (!this._whaleId) return this._card(this._muted(Lang.t('paper.whales_pick')));
        const d = this._whaleSnap;
        if (!d) return this._card(this._muted(Lang.t('paper.whales_error')));
        const status = String(this._pickField(d, ['status']) || '');
        // « unverified » / « error » : on montre le message, JAMAIS un chiffre
        // dont on ne repond pas.
        if (status === 'unverified' || status === 'error') {
            return this._card('<div style="color:var(--danger);font-size:14px;line-height:1.55;">' +
                esc(Lang.t('paper.whales_error')) + '</div>');
        }
        return this._whalesStats(d) + this._whalesTop(d) + this._whalesMoves(d);
    },

    _whalesStats(d) {
        const q = this._pickField(d, ['quarter']);
        const pq = this._pickField(d, ['prev_quarter']);
        const meta = [];
        if (q) meta.push(Lang.t('paper.whales_quarter') + ' ' + String(q));
        if (pq) meta.push(Lang.t('paper.whales_prev_quarter') + ' ' + String(pq));
        const stale = d.stale
            ? ' <span class="badge warn">' + esc(Lang.t('paper.whales_stale')) + '</span>'
            : '';
        const cell = (labelKey, value, unit) =>
            '<div class="stat-card">' +
              '<div class="label">' + esc(Lang.t(labelKey)) + '</div>' +
              '<div class="value">' + esc(value) +
                (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') + '</div>' +
            '</div>';
        const total = this._n(this._pickField(d, ['total_value_usd', 'total_value']));
        const conc = this._n(this._pickField(d, ['concentration_top10_pct', 'concentration_top10']));
        return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px;">' +
              (meta.length
                ? '<span style="font-size:13px;color:var(--text-muted);' + this._mono + '">' +
                  esc(meta.join(' · ')) + '</span>' : '') + stale +
            '</div>' +
            '<div class="bento-overview" style="grid-template-columns:repeat(3,1fr);' +
                 'grid-template-rows:auto;margin-bottom:14px;">' +
              cell('paper.whales_total_value', this._usd(total), '') +
              cell('paper.whales_n_positions',
                   this._num(this._n(this._pickField(d, ['n_positions'])), 0), '') +
              cell('paper.whales_concentration', this._num(conc, 1), '%') +
            '</div>';
    },

    // Barres en CSS pur : un div dont la largeur est un pourcentage calcule ici
    // (nombre borne 0-100, jamais une chaine venue du backend). Zero librairie.
    // Les barres sont RELATIVES a la plus grosse ligne — le chiffre imprime, lui,
    // est le vrai pourcentage ; c'est dit dans l'en-tete de section.
    _whalesTop(d) {
        const rows = Array.isArray(d.top) ? d.top.slice(0, 15) : [];
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.whales_top')) +
                this._muted(Lang.t('paper.no_data')));
        }
        let max = 0;
        rows.forEach((r) => { const p = this._n(r && r.pct); if (p !== null && p > max) max = p; });
        const bars = rows.map((r) => {
            const pct = this._n(r && r.pct);
            let w = (max > 0 && pct !== null) ? (pct / max) * 100 : 0;
            if (!isFinite(w) || w < 0) w = 0;
            if (w > 100) w = 100;
            const shares = this._n(r && r.shares);
            const chg = this._moveBadge(r && r.change);
            return '<div class="row" style="display:block;padding:9px 12px;">' +
                '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
                  '<span style="flex:1 1 200px;min-width:0;font-size:14px;">' +
                    esc((r && r.name) || '') + '</span>' + chg +
                  '<span style="' + this._mono + 'font-size:14px;font-weight:600;">' +
                    esc(this._num(pct, 2)) + ' %</span>' +
                  '<span style="' + this._mono + 'font-size:13px;color:var(--text-muted);' +
                       'min-width:96px;text-align:right;">' + esc(this._usd(r && r.value_usd)) + '</span>' +
                  (shares === null ? '' :
                    '<span style="' + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                    esc(this._num(shares, 0) + ' ' + Lang.t('paper.whales_shares')) + '</span>') +
                '</div>' +
                '<div style="height:6px;background:var(--bg-elev-3);border-radius:var(--r-pill);' +
                     'overflow:hidden;margin-top:7px;">' +
                  '<div style="height:100%;width:' + w.toFixed(2) + '%;background:var(--accent);' +
                       'border-radius:var(--r-pill);"></div>' +
                '</div>' +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_top'), Lang.t('paper.whales_bars_note')) +
            '<div class="row-list">' + bars + '</div>');
    },

    _moveBadge(change) {
        const c = String(change == null ? '' : change).toLowerCase();
        if (!c) return '';
        if (c === 'new') return '<span class="badge online">' + esc(Lang.t('paper.whales_new')) + '</span>';
        if (c === 'exit') return '<span class="badge danger">' + esc(Lang.t('paper.whales_exit')) + '</span>';
        if (c === 'increased' || c === 'up') {
            return '<span class="badge online">' + esc(Lang.t('paper.whales_increased')) + '</span>';
        }
        if (c === 'decreased' || c === 'down') {
            return '<span class="badge warn">' + esc(Lang.t('paper.whales_decreased')) + '</span>';
        }
        return '<span class="badge">' + esc(String(change)) + '</span>';
    },

    _whalesMoves(d) {
        const m = (d && d.moves && typeof d.moves === 'object') ? d.moves : {};
        const groups = [
            [this._pickField(m, ['new']), 'online', 'paper.whales_new'],
            [m.exits, 'danger', 'paper.whales_exit'],
            [m.increased, 'online', 'paper.whales_increased'],
            [m.decreased, 'warn', 'paper.whales_decreased'],
        ];
        let any = false;
        const blocks = groups.map((g) => {
            const rows = Array.isArray(g[0]) ? g[0] : [];
            if (!rows.length) return '';
            any = true;
            const items = rows.map((x) => {
                const name = (x && typeof x === 'object')
                    ? ((x.name || x.symbol || x.ticker) || '') : x;
                const delta = (x && typeof x === 'object') ? this._n(x.delta_pct) : null;
                return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
                       'flex-wrap:wrap;padding:7px 12px;">' +
                    '<span class="badge ' + g[1] + '">' + esc(Lang.t(g[2])) + '</span>' +
                    '<span style="flex:1 1 200px;min-width:0;font-size:14px;">' +
                      esc(String(name)) + '</span>' +
                    (delta === null ? '' :
                      '<span style="' + this._mono + 'font-size:13px;color:' +
                      this._color(delta) + ';">' + esc(this._signed(delta, 1, '%')) + '</span>') +
                '</div>';
            }).join('');
            return '<div style="margin-bottom:10px;"><div class="row-list">' + items + '</div></div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_moves')) +
            (any ? blocks : this._muted(Lang.t('paper.whales_moves_empty'))));
    },

    _whalesEventsCard() {
        const raw = this._whaleEvents;
        const rows = Array.isArray(raw) ? raw : ((raw && Array.isArray(raw.events)) ? raw.events : []);
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.whales_events')) +
                this._muted(Lang.t('paper.whales_events_empty')));
        }
        const items = rows.map((e) => {
            return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
                   'flex-wrap:wrap;padding:8px 12px;">' +
                '<span class="badge" style="' + this._mono + '">' +
                  esc((e && e.form) || '') + '</span>' +
                '<span style="flex:1 1 220px;min-width:0;font-size:14px;">' +
                  esc((e && e.label) || (e && e.manager_id) || '') + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(Lang.t('paper.whales_filed') + ' ' + this._date(e && e.filing_date)) + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(this._dateTime(e && e.ts)) + '</span>' +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_events')) +
            '<div class="row-list" style="max-height:320px;overflow:auto;">' + items + '</div>');
    },

    // Le fetch SEC a froid est PACE : jusqu'a ~10 s. On pose l'etat de
    // chargement AVANT l'appel et on le retire dans le finally — sinon un echec
    // laisse un loader eternel.
    async openWhale(id, force) {
        if (!id) return;
        if (!force && this._whaleId === id && this._whaleSnap) return;
        this._whaleId = String(id);
        this._whaleSnap = null;
        this._whaleLoading = true;
        if (this._tab === 'whales') this._renderBody();
        try {
            this._whaleSnap = await this._get('/api/paper/whales/' + encodeURIComponent(String(id)));
        } finally {
            this._whaleLoading = false;
            if (this._tab === 'whales') this._renderBody();
        }
    },

    // =====================================================================
    //  8. RADAR
    // =====================================================================

    _viewRadar() {
        if (!this._radar) return this._card(this._muted(Lang.t('paper.loading')));
        return this._radarStats() + this._radarList();
    },

    _radarStats() {
        const st = (this._radar && this._radar.stats && typeof this._radar.stats === 'object')
            ? this._radar.stats : {};
        const cell = (labelKey, v, color) =>
            '<div class="stat-card">' +
              '<div class="label">' + esc(Lang.t(labelKey)) + '</div>' +
              '<div class="value" style="color:' + color + ';">' +
                esc(this._num(this._n(v), 0)) + '</div>' +
            '</div>';
        return '<div class="bento-overview" style="grid-template-columns:repeat(3,1fr);' +
                    'grid-template-rows:auto;margin-bottom:14px;">' +
              cell('paper.radar_hits', st.hits, 'var(--accent)') +
              cell('paper.radar_misses', st.misses, 'var(--danger)') +
              cell('paper.radar_unclear', st.unclear, 'var(--text-muted)') +
            '</div>' +
            // Phrase permanente : le radar PARIE, il ne sait pas.
            '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
                 'background:var(--bg-elev-2);font-size:14px;line-height:1.5;' +
                 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
              '<span style="flex:1 1 320px;min-width:0;">' +
                esc(Lang.t('paper.radar_disclaimer')) + '</span>' +
              '<button class="btn btn-primary" data-paper-act="radar-run">' +
                esc(Lang.t('paper.radar_run')) + '</button>' +
            '</div>';
    },

    _radarHypotheses() {
        const r = this._radar;
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.hypotheses)) return r.hypotheses;
        return [];
    },

    _confidenceBadge(v) {
        const c = String(v == null ? '' : v).toLowerCase();
        if (!c) return '';
        if (c === 'high' || c === 'haute' || c === 'alta') {
            return '<span class="badge online">' + esc(Lang.t('paper.radar_conf_high')) + '</span>';
        }
        if (c === 'medium' || c === 'moyenne' || c === 'media') {
            return '<span class="badge warn">' + esc(Lang.t('paper.radar_conf_medium')) + '</span>';
        }
        if (c === 'low' || c === 'basse' || c === 'bassa') {
            return '<span class="badge">' + esc(Lang.t('paper.radar_conf_low')) + '</span>';
        }
        return '<span class="badge">' + esc(String(v)) + '</span>';
    },

    _outcomeBadge(o) {
        const c = String(o == null ? '' : o).toLowerCase();
        if (c === 'hit') return '<span class="badge online">' + esc(Lang.t('paper.radar_outcome_hit')) + '</span>';
        if (c === 'miss') return '<span class="badge danger">' + esc(Lang.t('paper.radar_outcome_miss')) + '</span>';
        if (c === 'unclear') return '<span class="badge">' + esc(Lang.t('paper.radar_outcome_unclear')) + '</span>';
        return '';
    },

    _radarList() {
        const rows = this._radarHypotheses();
        if (!rows.length) {
            return this._card(this._muted(Lang.t('paper.radar_empty')));
        }
        // Les hypotheses OUVERTES d'abord : ce sont les seules sur lesquelles on
        // peut encore apprendre quelque chose.
        const open = rows.filter((h) => String((h && h.status) || '') !== 'scored');
        const scored = rows.filter((h) => String((h && h.status) || '') === 'scored');
        return open.concat(scored).map((h) => this._radarCard(h)).join('');
    },

    _radarCard(h) {
        if (!h || typeof h !== 'object') return '';
        const isScored = (String(h.status || '') === 'scored');
        const move = this._n(h.move_pct);
        const list = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
        const chips = (labelKey, arr) => {
            const rows = list(arr);
            if (!rows.length) return '';
            return '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-top:6px;">' +
                '<span style="font-size:12px;color:var(--text-dim);min-width:70px;">' +
                  esc(Lang.t(labelKey)) + '</span>' +
                rows.map((x) => '<span class="badge" style="' + this._mono + '">' +
                    esc(String((x && typeof x === 'object') ? (x.name || x.symbol || '') : x)) +
                    '</span>').join('') +
            '</div>';
        };
        const horizon = this._n(h.horizon_days);
        const meta = [];
        if (h.direction) meta.push(Lang.t('paper.radar_direction') + ' ' + String(h.direction));
        if (horizon !== null) {
            meta.push(Lang.t('paper.radar_horizon') + ' ' + this._num(horizon, 0) + ' ' +
                Lang.t('paper.radar_days'));
        }
        if (h.created_at) meta.push(this._date(h.created_at));
        return this._card(
            '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px;">' +
              '<span style="flex:1 1 260px;min-width:0;font-size:16px;font-weight:600;line-height:1.45;">' +
                esc(h.thesis || '') + '</span>' +
              (isScored ? this._outcomeBadge(h.outcome)
                        : '<span class="badge">' + esc(Lang.t('paper.radar_open')) + '</span>') +
              this._confidenceBadge(h.confidence) +
              ((isScored && move !== null)
                ? '<span style="' + this._mono + 'font-size:15px;font-weight:600;color:' +
                  this._color(move) + ';">' + esc(this._signed(move, 2, '%')) + '</span>' : '') +
            '</div>' +
            (h.chain
              ? '<div style="font-size:14px;line-height:1.6;color:var(--text-muted);">' +
                esc(h.chain) + '</div>' : '') +
            chips('paper.radar_markets', h.markets) +
            chips('paper.radar_tickers', h.tickers) +
            (meta.length
              ? '<div style="font-size:12px;color:var(--text-dim);' + this._mono +
                   'margin-top:8px;">' + esc(meta.join(' · ')) + '</div>' : '') +
            (h.invalidation
              ? '<div style="margin-top:10px;border-left:2px solid var(--warning);padding-left:10px;' +
                     'font-size:13px;line-height:1.55;">' +
                '<span style="color:var(--warning);">' + esc(Lang.t('paper.radar_invalidation')) +
                '</span> : ' + esc(h.invalidation) + '</div>' : '')
        );
    },

    // Jusqu'a ~2 minutes : le bouton DIT qu'il travaille, et il est rendu meme
    // si l'appel echoue (finally).
    async runRadar(btn) {
        const prev = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = Lang.t('paper.radar_thinking'); }
        try {
            let r = null;
            try {
                r = await Auth.apiCall('/api/paper/radar/run',
                    { method: 'POST', body: JSON.stringify({}) });
            } catch (e) { r = null; }
            if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            const gen = this._n(d && d.generated);
            const sc = this._n(d && d.scored);
            this._toast('success', Lang.t('paper.radar_ran') + ' : ' +
                this._num(gen === null ? 0 : gen, 0) + ' ' + Lang.t('paper.radar_generated') + ', ' +
                this._num(sc === null ? 0 : sc, 0) + ' ' + Lang.t('paper.radar_scored'));
            this._radar = await this._get('/api/paper/radar') || this._radar;
            if (this._tab === 'radar') this._renderBody();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = prev; }
        }
    },

    // =====================================================================
    //  LLM — trois endpoints, jusqu'à 120 s : le bouton DIT qu'il travaille
    // =====================================================================

    async _llm(btn, url, body, apply) {
        const prev = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = Lang.t('paper.thinking'); }
        try {
            let r = null;
            try { r = await Auth.apiCall(url, { method: 'POST', body: JSON.stringify(body || {}) }); }
            catch (e) { r = null; }
            if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            apply(d);
        } finally {
            // Le corps a pu être re-rendu entre-temps : remettre l'état sur un
            // bouton détaché est sans effet, et c'est très bien ainsi.
            if (btn) { btn.disabled = false; btn.textContent = prev; }
        }
    },

    _llmText(d) {
        if (!d) return '';
        if (typeof d === 'string') return d;
        const v = this._pickField(d, ['text', 'message', 'answer', 'analysis', 'postmortem', 'report']);
        return v ? String(v) : '';
    },

    async ask(btn) {
        const el = document.getElementById('paper-question');
        const q = el ? String(el.value || '').trim() : '';
        await this._llm(btn, '/api/paper/coach/ask', { question: q }, (d) => {
            this._answer = this._llmText(d) || Lang.t('paper.no_data');
            if (this._tab === 'coach') this._renderBody();
        });
    },

    async analysis(btn) {
        const el = document.getElementById('paper-analysis-sym');
        const sym = el ? String(el.value || '').trim() : '';
        if (!sym) { this._toast('warn', Lang.t('paper.symbol_required')); return; }
        await this._llm(btn, '/api/paper/analysis', { symbol: sym }, (d) => {
            this._analysis = this._llmText(d) || Lang.t('paper.no_data');
            if (this._tab === 'coach') this._renderBody();
        });
    },

    async postmortem(btn, idx) {
        const body = (idx === null || idx === undefined) ? {} : { trade_index: idx };
        await this._llm(btn, '/api/paper/postmortem', body, (d) => {
            this._postmortem = this._llmText(d) || Lang.t('paper.no_data');
            if (this._tab === 'journal') this._renderBody();
        });
    },

    // =====================================================================
    //  Délégation d'événements
    // =====================================================================

    _click(ev) {
        const t = (ev.target && ev.target.closest) ? ev.target : null;
        if (!t) return;
        const tab = t.closest('[data-paper-tab]');
        if (tab) { ev.preventDefault(); this.switchTab(tab.getAttribute('data-paper-tab')); return; }
        const el = t.closest('[data-paper-act]');
        if (!el) return;
        const act = el.getAttribute('data-paper-act');
        ev.preventDefault();
        if (act === 'back') { this.back(); return; }
        if (act === 'refresh') { this.refresh(); return; }
        if (act === 'pick') {
            this.pick(el.getAttribute('data-sym'), el.getAttribute('data-name'),
                el.getAttribute('data-cur'), el.getAttribute('data-exch'));
            return;
        }
        if (act === 'submit-order') { this.submitOrder(); return; }
        if (act === 'close-pos') { this.closePosition(el.getAttribute('data-sym')); return; }
        if (act === 'cancel-order') { this.cancelOrder(el.getAttribute('data-id')); return; }
        if (act === 'open-trade') {
            const i = parseInt(el.getAttribute('data-idx'), 10);
            this._tradeIdx = (this._tradeIdx === i) ? null : (isFinite(i) ? i : null);
            this._postmortem = null;
            this._renderBody();
            return;
        }
        if (act === 'close-trade') { this._tradeIdx = null; this._postmortem = null; this._renderBody(); return; }
        if (act === 'postmortem') {
            const i = parseInt(el.getAttribute('data-idx'), 10);
            this.postmortem(el, isFinite(i) ? i : null);
            return;
        }
        if (act === 'ask') { this.ask(el); return; }
        if (act === 'analysis') { this.analysis(el); return; }
        if (act === 'open-note') { this.openNote(el.getAttribute('data-note')); return; }
        if (act === 'close-note') { this._noteName = null; this._noteBody = null; this._renderBody(); return; }
        if (act === 'open-lesson') {
            this._lessonId = el.getAttribute('data-lesson');
            this._quizResult = null;
            this._renderBody();
            return;
        }
        if (act === 'close-lesson') {
            this._lessonId = null; this._quizResult = null; this._renderBody(); return;
        }
        if (act === 'quiz-submit') { this.submitQuiz(el.getAttribute('data-lesson')); return; }
        if (act === 'arena-accept') { this.acceptArena(); return; }
        if (act === 'reset') { this.resetPortfolio(); return; }
        if (act === 'whale-pick') { this.openWhale(el.getAttribute('data-whale')); return; }
        if (act === 'radar-run') { this.runRadar(el); }
    },

    _input(ev) {
        const el = ev.target;
        if (!el || !el.getAttribute) return;
        if (el.id === 'paper-q') {
            const v = el.value;
            this._form.q = v;
            if (this._searchTimer) clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => { this._searchTimer = null; this.search(v); }, 400);
            return;
        }
        if (el.getAttribute && el.getAttribute('data-paper-size')) {
            this._captureForm();
            // Changer le type d'ordre fait apparaître/disparaître le champ de
            // prix : là seulement on redessine.
            if (el.id === 'paper-kind') { this._renderBody(); return; }
            this._paintSizing();
        }
    },
};
