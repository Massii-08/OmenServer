// frontend/js/clipping_module.js
// Extraits de lives présélectionnés par l'enregistreur : consultation par jour /
// live / extrait, et téléchargement (un extrait, un live entier ou tout un jour
// en zip).
//
// Téléchargement : un lien <a href> ne porte pas le header Authorization et un
// blob JS de plusieurs Go est exclu → POST /api/clipping/ticket (authentifié)
// renvoie une URL à usage unique (120 s) qu'on ouvre via window.location.href :
// le navigateur télécharge nativement, en flux.
//
// Règles du dépôt : vanilla JS, appels via Auth.apiCall, textes via
// Lang.t('clipping.*'), toute donnée passe par esc(), un seul écouteur délégué
// (data-*) retiré dans unload().
const ClippingModule = {
    JOURS_OPTIONS: [1, 3, 7, 14],
    _container: null,
    _onClick: null,
    _onChange: null,
    _gen: 0,
    _jours: 3,
    _data: null,
    _error: false,
    _busy: false,

    async render(container) {
        this.unload();
        this._container = container;
        this._data = null;
        this._error = false;
        container.innerHTML = this._shell();
        this._bind();
        await this._load();
    },

    unload() {
        this._gen++;
        if (this._container) {
            if (this._onClick) this._container.removeEventListener('click', this._onClick);
            if (this._onChange) this._container.removeEventListener('change', this._onChange);
        }
        this._onClick = null;
        this._onChange = null;
    },

    back() {
        this.unload();
        if (typeof BotsModule !== 'undefined' && BotsModule.render) BotsModule.render(BotsModule._container);
    },

    // ------------------------------------------------------------- outils

    _fmtSize(n) {
        const v = Number(n) || 0;
        if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
        if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' Mo';
        if (v >= 1024) return Math.round(v / 1024) + ' Ko';
        return v + ' o';
    },

    _fmtDuration(s) {
        const v = Math.round(Number(s) || 0);
        if (!v) return '';
        const m = Math.floor(v / 60);
        const r = v % 60;
        return m + ':' + String(r).padStart(2, '0');
    },

    _btn(kind, target, label, primary) {
        return '<button class="btn ' + (primary ? 'btn-primary' : 'btn-ghost') + ' btn-sm" data-clp-dl="' +
            esc(kind) + '" data-clp-target="' + esc(target) + '">' + esc(label) + '</button>';
    },

    // ------------------------------------------------------------- rendu

    _shell() {
        const opts = this.JOURS_OPTIONS.map(n =>
            '<option value="' + n + '"' + (n === this._jours ? ' selected' : '') + '>' +
            esc(Lang.t('clipping.days_' + n)) + '</option>').join('');
        return '' +
            '<div class="card">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
            '<div><h3 style="margin:0;">' + esc(Lang.t('clipping.title')) + '</h3>' +
            '<p style="color:var(--text-muted);font-size:13px;margin:4px 0 0;">' + esc(Lang.t('clipping.subtitle')) + '</p></div>' +
            '<div style="display:flex;gap:8px;align-items:center;">' +
            '<select class="form-input" data-clp-jours style="width:auto;">' + opts + '</select>' +
            '<button class="btn btn-ghost btn-sm" data-clp-act="refresh">' + esc(Lang.t('clipping.refresh')) + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-clp-act="back">' + esc(Lang.t('clipping.back')) + '</button>' +
            '</div></div>' +
            '<div id="clp-body"><div style="padding:20px;color:var(--text-muted);text-align:center;">' +
            esc(Lang.t('clipping.loading')) + '</div></div>' +
            '</div>';
    },

    _bind() {
        const c = this._container;
        if (!c) return;
        this._onClick = (ev) => {
            const dl = ev.target.closest('[data-clp-dl]');
            if (dl && c.contains(dl)) {
                ev.preventDefault();
                this._download(dl.dataset.clpDl, dl.dataset.clpTarget, dl);
                return;
            }
            const act = ev.target.closest('[data-clp-act]');
            if (act && c.contains(act)) {
                ev.preventDefault();
                if (act.dataset.clpAct === 'back') this.back();
                else if (act.dataset.clpAct === 'refresh') this._load();
            }
        };
        this._onChange = (ev) => {
            const sel = ev.target.closest('[data-clp-jours]');
            if (!sel) return;
            const n = parseInt(sel.value, 10);
            if (this.JOURS_OPTIONS.indexOf(n) !== -1) {
                this._jours = n;
                this._load();
            }
        };
        c.addEventListener('click', this._onClick);
        c.addEventListener('change', this._onChange);
    },

    async _load() {
        const gen = this._gen;
        const body = document.getElementById('clp-body');
        if (body) body.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">' +
            esc(Lang.t('clipping.loading')) + '</div>';
        let data = null;
        let error = false;
        try {
            const res = await Auth.apiCall('/api/clipping/extraits?jours=' + this._jours);
            if (res && res.ok) data = await res.json();
            else error = true;
        } catch (e) {
            error = true;
        }
        if (gen !== this._gen) return;
        this._data = data;
        this._error = error;
        this._renderBody();
    },

    _renderBody() {
        const body = document.getElementById('clp-body');
        if (!body) return;
        if (this._error) {
            body.innerHTML = '<div style="padding:20px;color:var(--danger);text-align:center;">' +
                esc(Lang.t('clipping.error')) + '</div>';
            return;
        }
        const jours = (this._data && Array.isArray(this._data.jours)) ? this._data.jours : [];
        if (!jours.length) {
            body.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center;">' +
                esc(Lang.t('clipping.empty')) + '</div>';
            return;
        }
        body.innerHTML = jours.map(j => this._renderDay(j)).join('');
    },

    _renderDay(j) {
        const lives = Array.isArray(j.lives) ? j.lives : [];
        const count = lives.reduce((a, l) => a + (Array.isArray(l.extraits) ? l.extraits.length : 0), 0);
        return '' +
            '<div style="margin-top:20px;">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' +
            'padding-bottom:8px;border-bottom:1px solid var(--border);">' +
            '<div><strong style="font-family:var(--font-mono);font-feature-settings:\'tnum\';">' + esc(j.date) + '</strong>' +
            '<span style="color:var(--text-muted);font-size:13px;margin-left:10px;font-family:var(--font-mono);font-feature-settings:\'tnum\';">' +
            esc(count + ' ' + Lang.t('clipping.clips')) + ' · ' + esc(this._fmtSize(j.total_octets)) + '</span></div>' +
            this._btn('jour', j.date, Lang.t('clipping.dl_day'), true) +
            '</div>' +
            lives.map(l => this._renderLive(l)).join('') +
            '</div>';
    },

    _renderLive(l) {
        const extraits = Array.isArray(l.extraits) ? l.extraits : [];
        const meta = [l.plateforme, l.langue].filter(Boolean).map(s => esc(s)).join(' · ');
        const badge = l.en_cours ? ' <span class="badge warn">' + esc(Lang.t('clipping.live_running')) + '</span>' : '';
        const rows = extraits.map(e => {
            const dur = this._fmtDuration(e.duree_s);
            const score = (typeof e.score === 'number') ? e.score.toFixed(2) : '—';
            return '' +
                '<div class="row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
                '<div style="font-family:var(--font-mono);font-feature-settings:\'tnum\';font-size:13px;">' +
                '<strong>#' + esc(e.rang_global) + '</strong>' +
                '<span style="color:var(--text-muted);margin-left:12px;">' + esc(Lang.t('clipping.slice')) + ' ' + esc(e.tranche) + '</span>' +
                '<span style="color:var(--text-muted);margin-left:12px;">' + esc(Lang.t('clipping.score')) + ' ' + esc(score) + '</span>' +
                (dur ? '<span style="color:var(--text-muted);margin-left:12px;">' + esc(dur) + '</span>' : '') +
                '<span style="color:var(--text-muted);margin-left:12px;">' + esc(this._fmtSize(e.taille_octets)) + '</span>' +
                '</div>' +
                this._btn('extrait', e.chemin, Lang.t('clipping.dl_clip'), false) +
                '</div>';
        }).join('');
        return '' +
            '<div style="margin-top:14px;">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px;">' +
            '<div><strong>' + esc(l.streamer) + '</strong>' + badge +
            (meta ? '<span style="color:var(--text-muted);font-size:13px;margin-left:10px;">' + meta + '</span>' : '') +
            (l.titre ? '<div style="color:var(--text-dim);font-size:12px;margin-top:2px;">' + esc(l.titre) + '</div>' : '') +
            '</div>' +
            this._btn('live', l.id, Lang.t('clipping.dl_live'), false) +
            '</div>' +
            '<div class="row-list">' + rows + '</div>' +
            '</div>';
    },

    // ------------------------------------------------------------- téléchargement

    async _download(kind, target, btn) {
        if (this._busy) return;
        this._busy = true;
        if (btn) btn.disabled = true;
        try {
            const res = await Auth.apiCall('/api/clipping/ticket', {
                method: 'POST',
                body: JSON.stringify({ type: kind, cible: target }),
            });
            if (!res) return;
            if (!res.ok) {
                if (typeof Toast !== 'undefined') Toast.error(Lang.t(res.status === 404 ? 'clipping.not_found' : 'clipping.dl_error'));
                return;
            }
            const data = await res.json();
            const url = data && typeof data.url === 'string' ? data.url : '';
            // Uniquement un chemin relatif de notre propre API.
            if (!url.startsWith('/api/clipping/telecharger/')) {
                if (typeof Toast !== 'undefined') Toast.error(Lang.t('clipping.dl_error'));
                return;
            }
            if (kind !== 'extrait' && typeof Toast !== 'undefined') Toast.info(Lang.t('clipping.zip_preparing'));
            window.location.href = url;
        } catch (e) {
            if (typeof Toast !== 'undefined') Toast.error(Lang.t('clipping.dl_error'));
        } finally {
            this._busy = false;
            if (btn) btn.disabled = false;
        }
    },
};

window.ClippingModule = ClippingModule;
