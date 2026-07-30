/**
 * oracle_module.js — Dashboard du bot Oracle (Polymarket × Deribit).
 *
 * Espace dédié dans le module Bots : santé + verdict, portefeuille fictif
 * (courbe d'équité), analyses de marché (edges, calibration, near-misses),
 * transactions (paper fantômes + alertes), en-cours (pending par échéance).
 *
 * Lecture seule : consomme /api/bots/oracle/snapshot (JSON produit par le
 * projet Oracle à chaque cycle). Graphiques = SVG inline fait main, thème-aware
 * (couleurs via var(--…)), zéro dépendance (CSP bloque les libs CDN).
 * Toute donnée serveur passe par esc() avant innerHTML (anti-XSS).
 */
const OracleModule = {
    _container: null,
    _pollInterval: null,
    _snap: null,
    // Venue affichée (2026-07-20) : chaque venue = une instance Oracle et
    // son snapshot ; le switch recharge simplement l'autre JSON.
    // 'mk' (2026-07-30) : Oracle MK, forme de snapshot totalement différente
    // (execution/rules/verdict) → vue dédiée, voir section "Oracle MK" plus bas.
    _venue: 'polymarket',
    _MK_RULE_KEYS: ['fade_maker', 'fade_taker', 'random_control'],

    async render(container) {
        this.unload();               // coupe tout poll précédent (ré-ouverture / re-render) avant d'en armer un neuf
        this._container = container;
        container.innerHTML = `
            <div class="oracle-wrap oracle-enter" id="oracle-wrap">
                <div class="oracle-topbar">
                    <button class="btn btn-ghost btn-sm" onclick="OracleModule.unload();BotsModule.render(BotsModule._container)">${esc(Lang.t('oracle.back'))}</button>
                    <div class="oracle-title">
                        <span class="b-ticker">ORC</span>
                        <div>
                            <div class="oracle-h1">Oracle</div>
                            <div class="oracle-sub" id="oracle-sub">${esc(this._subtitle())}</div>
                        </div>
                    </div>
                    <div class="lang-switcher oracle-venues" id="oracle-venues">
                        <button class="lang" data-venue="polymarket" onclick="OracleModule._setVenue('polymarket')">Polymarket</button>
                        <button class="lang" data-venue="kalshi" onclick="OracleModule._setVenue('kalshi')">Kalshi</button>
                        <button class="lang" data-venue="mk" onclick="OracleModule._setVenue('mk')">MK</button>
                    </div>
                    <div class="oracle-top-right" id="oracle-top-right"></div>
                </div>
                <div id="oracle-body">
                    <div class="oracle-loading">${esc(Lang.t('common.loading'))}</div>
                </div>
            </div>`;
        this._syncVenuePills();
        await this._load();
        // Retire la classe d'entrée après l'animation (comme anim.js pour
        // .view-enter) → les refresh du poll ne ré-animent pas.
        setTimeout(() => { const w = document.getElementById('oracle-wrap'); if (w) w.classList.remove('oracle-enter'); }, 1400);
        this._pollInterval = setInterval(() => this._load(), 30000);
    },

    _reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    _isEntering() {
        const w = document.getElementById('oracle-wrap');
        return !!(w && w.classList.contains('oracle-enter'));
    },

    unload() {
        if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    },

    _setVenue(v) {
        if (v === this._venue || (v !== 'polymarket' && v !== 'kalshi' && v !== 'mk')) return;
        this._venue = v;
        this._syncVenuePills();
        const body = document.getElementById('oracle-body');
        if (body) body.innerHTML = `<div class="oracle-loading">${esc(Lang.t('common.loading'))}</div>`;
        this._load();
    },

    // Le sous-titre suit la place : sur MK, afficher « Polymarket × Deribit
    // — détecteur d'écarts » serait activement trompeur, c'est la thèse
    // prévisionniste qui a été mesurée morte et que MK ne teste PAS.
    _subtitle() {
        return this._venue === 'mk'
            ? Lang.t('oracle.mk.subtitle')
            : Lang.t('oracle.subtitle');
    },

    _syncVenuePills() {
        const wrap = document.getElementById('oracle-venues');
        if (!wrap) return;
        wrap.querySelectorAll('.lang').forEach(b =>
            b.classList.toggle('active', b.dataset.venue === this._venue));
        const sub = document.getElementById('oracle-sub');
        if (sub) sub.textContent = this._subtitle();
    },

    async _load() {
        const venue = this._venue;
        const r = await Auth.apiCall(`/api/bots/oracle/snapshot?venue=${encodeURIComponent(venue)}`);
        if (venue !== this._venue) return; // switch pendant le fetch : réponse périmée
        const body = document.getElementById('oracle-body');
        if (!body) return;                 // module déchargé entre-temps
        if (!r) return;                    // 401 géré par Auth.apiCall
        if (r.status === 404) { body.innerHTML = this._notReady(); this._topBadge(null); return; }
        if (!r.ok) { body.innerHTML = `<div class="oracle-empty">${esc(Lang.t('oracle.load_error'))} (${r.status})</div>`; return; }
        try {
            this._snap = await r.json();
        } catch (e) { body.innerHTML = `<div class="oracle-empty">${esc(Lang.t('oracle.load_error'))}</div>`; return; }
        // Oracle MK (2026-07-30) : forme de snapshot incompatible avec la vue
        // v1 (execution/rules/verdict au lieu de health/bankroll/edges) → vue dédiée.
        if (venue === 'mk') {
            body.innerHTML = this._dashboardMk(this._snap);
            this._topBadge(this._snap);
        } else {
            body.innerHTML = this._dashboard(this._snap);
            this._topBadge(this._snap);
            this._drawCharts(this._snap);
        }
    },

    _notReady() {
        return `<div class="oracle-empty">
            <div class="oracle-empty-h">${esc(Lang.t('oracle.not_ready'))}</div>
            <div class="oracle-empty-p">${esc(Lang.t('oracle.not_ready_hint'))}</div>
        </div>`;
    },

    _topBadge(snap) {
        const el = document.getElementById('oracle-top-right');
        if (!el) return;
        if (!snap) { el.innerHTML = ''; return; }
        if (this._venue === 'mk') { this._topBadgeMk(snap); return; }
        const h = snap.health || {};
        const mode = esc(h.executor_mode || 'paper');
        // Le champ health.status a été calculé À L'ÉCRITURE du snapshot : il
        // reste « ok » pour toujours si le bot s'arrête. C'est l'ÂGE RÉEL du
        // fichier qui dit s'il tourne encore — sinon on affiche « LIVE » et
        // « dernier cycle 0,7 min » pour un bot mort depuis 5 jours (vécu).
        const age = this._snapAgeMin(snap);
        let cls, lbl;
        if (age !== null && age > 95) {
            cls = 'danger';
            lbl = Lang.t('oracle.stopped');
        } else {
            cls = { ok: 'online', warn: 'warn', error: 'danger' }[h.status] || '';
            lbl = { ok: 'LIVE', warn: Lang.t('oracle.degraded'), error: 'STALE', unknown: '—' }[h.status] || '—';
        }
        el.innerHTML = `<span class="oracle-mode">${esc(Lang.t('oracle.mode'))}: <b>${mode}</b></span><span class="badge ${cls}">${esc(lbl)}</span>`;
    },

    // Âge RÉEL du snapshot en minutes (null si l'horodatage est absent ou
    // illisible). Sert à ne jamais présenter une valeur stockée comme fraîche.
    _snapAgeMin(snap) {
        const raw = (snap && (snap.generated_iso || snap.ts)) || null;
        if (raw === null) return null;
        const ms = typeof raw === 'number' ? raw * 1000 : Date.parse(raw);
        if (!Number.isFinite(ms)) return null;
        return (Date.now() - ms) / 60000;
    },

    _ageLabel(min) {
        if (min === null) return '—';
        if (min < 90) return Math.round(min) + ' min';
        if (min < 48 * 60) return Math.round(min / 60) + ' h';
        return Math.round(min / 1440) + ' ' + Lang.t('oracle.unit_day');
    },

    // ---------------------------------------------------------- dashboard

    _dashboard(s) {
        return [
            this._verdictStrip(s),
            this._horizons(s),
            this._overview(s),
            this._portfolio(s),
            this._simPerformance(s),
            this._openBets(s),
            this._market(s),
            this._transactions(s),
            this._inProgress(s),
            this._footer(s),
        ].join('');
    },

    // --- Où vit l'edge ? : Brier par horizon + compteur du test pré-enregistré
    // (sections snapshot `brier_horizons` + `prereg`, absentes des vieux
    // snapshots → la section disparaît proprement).
    _horizons(s) {
        const hs = Array.isArray(s.brier_horizons) ? s.brier_horizons.filter(h => h && h.n > 0) : [];
        const pre = (s.prereg && s.prereg.brier) ? s.prereg : null;
        if (!hs.length && !pre) return '';
        const v = s.verdict || {};
        const minN = v.min_n || 40, minC = v.min_clusters || 15;
        const fmt5 = x => (x > 0 ? '+' : '') + Number(x).toFixed(5);
        const rows = hs.length ? hs.map(h => {
            const cls = h.diff < 0 ? 'pos' : h.diff > 0 ? 'neg' : '';
            const ci = (h.ci_low != null && h.ci_high != null) ? ` · IC [${Number(h.ci_low).toFixed(4)}, ${Number(h.ci_high).toFixed(4)}]` : '';
            return `<div class="t-row">
                <div><div class="t-name mono">τ≈${Number(h.h_hours).toFixed(0)} h <span class="opn">${esc(Lang.t('oracle.horizon_before_close'))}</span></div>
                <div class="t-sub mono">n=${h.n} · ${Number(h.brier_model).toFixed(5)} vs ${Number(h.brier_market).toFixed(5)}${ci}</div></div>
                <div class="t-meta ${cls} mono">${fmt5(h.diff)}</div>
            </div>`;
        }).join('') : `<div class="oracle-empty-sm">${esc(Lang.t('oracle.none'))}</div>`;
        let preBlock = '';
        if (pre) {
            const b = pre.brier || {};
            const n = b.n || 0, cl = b.n_clusters || 0;
            const met = !!pre.certified;
            const diffLine = (n > 0 && b.diff != null)
                ? `<div class="t-sub mono">diff ${fmt5(b.diff)} · IC [${Number(b.ci_low).toFixed(4)}, ${Number(b.ci_high).toFixed(4)}]</div>`
                : `<div class="t-sub">${esc(Lang.t('oracle.prereg_waiting'))}</div>`;
            preBlock = `<div class="oracle-panel">
                <div class="oracle-panel-title">${esc(Lang.t('oracle.prereg'))} <span class="badge ${met ? 'online' : ''}">${esc(met ? Lang.t('oracle.prereg_met') : Lang.t('oracle.prereg_running'))}</span></div>
                <div class="t-sub">${esc(Lang.t('oracle.prereg_desc'))} <span class="mono">(${esc(Lang.t('oracle.prereg_since'))} ${this._shortDT(pre.since_iso)})</span></div>
                <div class="ov-bar-row"><span class="ov-lab mono">n</span>${this._progress(100 * Math.min(n / minN, 1))}<span class="ov-val mono">${n}/${minN}</span></div>
                <div class="ov-bar-row"><span class="ov-lab mono">clusters</span>${this._progress(100 * Math.min(cl / minC, 1))}<span class="ov-val mono">${cl}/${minC}</span></div>
                ${diffLine}
            </div>`;
        }
        // Calibration du modèle (snapshot.reliability) : prédit vs réalisé
        // par tranche — un gap fort = zone aveugle du modèle.
        const rel = Array.isArray(s.reliability) ? s.reliability.filter(b => b && b.n > 0) : [];
        const relRows = rel.map(b => {
            const bad = Math.abs(b.gap || 0) >= 0.05;
            return `<div class="t-row">
                <div><div class="t-name mono">${esc(String(b.bucket || ''))}</div>
                <div class="t-sub mono">n=${b.n} · ${esc(Lang.t('oracle.predicted'))} ${(b.predicted * 100).toFixed(1)}% · ${esc(Lang.t('oracle.realized'))} ${(b.realized * 100).toFixed(1)}%</div></div>
                <div class="t-meta ${bad ? 'neg' : ''} mono">${b.gap > 0 ? '+' : ''}${(b.gap * 100).toFixed(1)}%</div>
            </div>`;
        }).join('');
        const relBlock = rel.length
            ? `<div class="oracle-panel"><div class="oracle-panel-title">${esc(Lang.t('oracle.reliability'))} <span class="opn">${esc(Lang.t('oracle.reliability_desc'))}</span></div><div class="oracle-table">${relRows}</div></div>`
            : '';
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.horizons'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.horizons_desc'))}</span></div>
            <div class="oracle-grid-2">
                <div class="oracle-panel"><div class="oracle-table">${rows}</div></div>
                ${preBlock}
            </div>
            ${relBlock}
        </div>`;
    },

    // --- Performance en simulation : bilan par seuil d'edge (est-ce que ça marche ?)
    _simPerformance(s) {
        const perf = Array.isArray(s.sim_performance) ? s.sim_performance : [];
        const anyResolved = perf.some(p => p.n > 0);
        const body = anyResolved
            ? `<div class="oracle-table with-head oracle-perf-tbl">
                <div class="t-head"><span>${esc(Lang.t('oracle.threshold'))}</span><span>${esc(Lang.t('oracle.bets_col'))}</span><span>${esc(Lang.t('oracle.win_rate'))}</span><span>P&L</span></div>
                ${perf.map(p => {
                    const wr = p.win_rate != null ? `${(p.win_rate * 100).toFixed(0)}%` : '—';
                    const pnlCls = p.total_pnl_usd > 0 ? 'pos' : p.total_pnl_usd < 0 ? 'neg' : '';
                    const pnl = p.n ? `<span class="mono ${pnlCls}">${p.total_pnl_usd > 0 ? '+' : ''}${Number(p.total_pnl_usd).toFixed(2)}$</span>` : '<span class="mono">—</span>';
                    return `<div class="t-row oracle-perfrow ${p.is_bot_threshold ? 'bot' : ''}">
                        <div class="t-name mono">≥ ${(p.threshold * 100).toFixed(0)}%${p.is_bot_threshold ? ` <span class="oracle-chip">${esc(Lang.t('oracle.real_bot'))}</span>` : ''}</div>
                        <div class="t-meta mono">${p.n}</div>
                        <div class="t-meta mono">${wr}</div>
                        <div class="t-meta">${pnl}</div>
                    </div>`;
                }).join('')}
            </div>`
            : `<div class="oracle-panel"><div class="oracle-empty-sm">${esc(Lang.t('oracle.sim_waiting'))}</div></div>`;
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.sim_performance'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.sim_performance_desc'))}</span></div>
            ${body}
        </div>`;
    },

    // "2026-07-13 15:09" → "13/07 15:09" ; "2026-07-17" → "17/07"
    _shortDT(iso) {
        if (!iso) return '—';
        const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
        return m ? m[3] + '/' + m[2] + (m[4] ? ' ' + m[4] : '') : esc(String(iso));
    },

    // --- Paris ouverts : positions fictives en cours, à analyser soi-même
    _openBets(s) {
        const open = (Array.isArray(s.transactions) ? s.transactions : [])
            .filter(t => t.status === 'open');
        const body = open.length
            ? `<div class="oracle-table with-head oracle-open-tbl">
                <div class="t-head"><span>${esc(Lang.t('oracle.market_col'))}</span><span>${esc(Lang.t('oracle.placed'))}</span><span>${esc(Lang.t('oracle.price_col'))}</span><span>${esc(Lang.t('oracle.cost'))}</span><span>${esc(Lang.t('oracle.potential_gain'))}</span><span>${esc(Lang.t('oracle.ends'))}</span></div>
                ${open.map(t => {
                    // Coût/gain = dimensionnement RÉEL du portefeuille (Kelly/4 du pot 100$),
                    // pas la mise fixe 100$ → tout se réconcilie avec le portefeuille.
                    const stake = t.model_stake_usd != null ? t.model_stake_usd : t.stake_usd;
                    const g = t.model_gain_usd != null ? t.model_gain_usd : t.potential_gain_usd;
                    const gain = g != null ? `<span class="mono pos">+${Number(g).toFixed(2)}$</span>` : '<span class="mono">—</span>';
                    const pricePct = t.price != null ? `${(t.price * 100).toFixed(0)}%` : '—';
                    return `<div class="t-row oracle-openrow">
                        <div><div class="t-name">${esc(t.question || '')}</div><div class="t-sub mono">${esc(t.side || '')} · ${esc(t.kind || '')} · edge ${this._pct(t.edge_net)}</div></div>
                        <div class="t-meta mono">${this._shortDT(t.ts_iso)}</div>
                        <div class="t-meta mono">${pricePct}</div>
                        <div class="t-meta mono">${stake != null ? Number(stake).toFixed(2) : '—'}$</div>
                        <div class="t-meta">${gain}</div>
                        <div class="t-meta mono">${this._shortDT(t.end_date)}</div>
                    </div>`;
                }).join('')}
            </div>`
            : `<div class="oracle-panel"><div class="oracle-empty-sm">${esc(Lang.t('oracle.no_open_bets'))}</div></div>`;
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.open_bets'))} ${open.length ? `<span class="oracle-chip">${open.length}</span>` : ''}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.open_bets_desc'))}</span></div>
            ${body}
        </div>`;
    },

    _num(v, dec = 0, suffix = '') {
        if (v === null || v === undefined || Number.isNaN(v)) return '—';
        return `<span class="mono">${Number(v).toFixed(dec)}${suffix}</span>`;
    },

    _pct(v) {
        if (v === null || v === undefined) return '—';
        const sign = v > 0 ? '+' : '';
        return `<span class="mono">${sign}${(v * 100).toFixed(1)}%</span>`;
    },

    // --- Santé + progrès du verdict phase 2
    _verdictStrip(s) {
        const h = s.health || {}, v = s.verdict || {};
        const reelMin = this._snapAgeMin(s);
        const items = [
            // « dernier cycle » = l'âge RÉEL du snapshot, pas la valeur qui
            // était vraie au moment de son écriture et qui reste gelée après
            // l'arrêt du bot.
            { l: Lang.t('oracle.cycles_24h'), v: reelMin !== null && reelMin > 95 ? '0' : (h.cycles_24h ?? '—'), warn: reelMin !== null && reelMin > 95 },
            { l: Lang.t('oracle.last_cycle'), v: this._ageLabel(reelMin), err: reelMin !== null && reelMin > 95 },
            { l: 'Degraded', v: h.degraded_cycles ?? 0, err: (h.degraded_cycles || 0) >= 3, warn: (h.degraded_cycles || 0) > 0 },
            { l: Lang.t('oracle.executor'), v: h.executor_mode || 'paper' },
        ];
        const cells = items.map(i => `<div class="diag-item ${i.err ? 'err' : i.warn ? 'warn' : ''}"><span class="d-l">${esc(i.l)}</span><span class="d-v">${esc(String(i.v))}</span></div>`).join('');
        const nPct = v.pct_n ?? 0, cPct = v.pct_clusters ?? 0;
        const statusTxt = (reelMin !== null && reelMin > 95)
            ? Lang.t('oracle.stopped')
            : ({ ok: Lang.t('oracle.healthy'), warn: Lang.t('oracle.degraded'), error: Lang.t('oracle.stale'), unknown: '—' }[h.status] || '—');
        return `<div class="diag-strip oracle-health">
            <div class="d-head"><span class="d-title">${esc(Lang.t('oracle.health'))}</span><span class="d-summary">${esc(statusTxt)}</span></div>
            <div class="diag-grid">${cells}</div>
            <div class="oracle-verdict">
                <div class="ov-title">${esc(Lang.t('oracle.verdict_progress'))}</div>
                <div class="ov-bar-row"><span class="ov-lab mono">n</span>${this._progress(nPct)}<span class="ov-val mono">${v.n_resolved ?? 0}/${v.min_n ?? 40}</span></div>
                <div class="ov-bar-row"><span class="ov-lab mono">clusters</span>${this._progress(cPct)}<span class="ov-val mono">${v.clusters ?? 0}/${v.min_clusters ?? 15}</span></div>
                <div class="ov-eta">${esc(Lang.t('oracle.verdict_note'))}</div>
            </div>
        </div>`;
    },

    _progress(pct) {
        const p = Math.max(0, Math.min(100, pct || 0));
        return `<div class="ov-track"><div class="ov-fill" style="width:${p}%"></div></div>`;
    },

    // --- Cartes de synthèse (Bento overview)
    // KPI principal = les VRAIES alertes (les paris du bot) — le pot de
    // calibration (paris fantômes sous le seuil) est rétrogradé en carte
    // secondaire : 2 confusions vécues où sa variance passait pour une
    // « perte du bot » (2026-07-21).
    _overview(s) {
        const b = s.bankroll || {}, u = s.universe || {}, p = s.paper || {};
        const rpnl = p.total_pnl_usd;
        const rCls = rpnl > 0 ? 'up' : rpnl < 0 ? 'down' : '';
        const rEdge = p.avg_realized_edge != null
            ? ` · ${esc(Lang.t('oracle.realized_edge'))} ${(p.avg_realized_edge * 100).toFixed(1)}%` : '';
        const pnl = b.net_pnl;
        const best = (s.edges && s.edges.near_misses && s.edges.near_misses[0]) || null;
        return `<div class="bento-overview oracle-kpi">
            <div class="stat-card big">
                <span class="label">${esc(Lang.t('oracle.real_alerts_pnl'))}</span>
                <div class="value"><span class="delta ${rCls}">${rpnl != null ? (rpnl > 0 ? '+' : '') + Number(rpnl).toFixed(2) : '—'}</span><span class="unit">$</span></div>
                <div class="footer">${this._num(p.n_resolved)} ${esc(Lang.t('oracle.settled_short'))} · ${this._num(p.n_open)} ${esc(Lang.t('oracle.open_short'))}${rEdge}</div>
            </div>
            <div class="stat-card"><span class="label">${esc(Lang.t('oracle.calibration_pot'))}</span><div class="value">${this._num(b.final, 2)}<span class="unit">$</span></div><div class="footer">${pnl != null ? (pnl > 0 ? '+' : '') + Number(pnl).toFixed(2) + '$' : '—'} · ${this._num(b.n_bets)} ${esc(Lang.t('oracle.settled_short'))}</div></div>
            <div class="stat-card"><span class="label">${esc(Lang.t('oracle.best_edge_24h'))}</span><div class="value">${best ? this._pct(best.edge_net) : '—'}</div><div class="footer">${best ? esc((best.side || '') + ' · ' + (best.asset || '')) : esc(Lang.t('oracle.none'))}</div></div>
            <div class="stat-card"><span class="label">${esc(Lang.t('oracle.evaluated'))}</span><div class="value">${this._num(u.evaluated)}</div><div class="footer">${this._num(u.candidates)} ${esc(Lang.t('oracle.candidates'))}</div></div>
        </div>`;
    },

    // --- Portefeuille fictif : courbe d'équité + résumé
    _portfolio(s) {
        const b = s.bankroll || {};
        const open = (Array.isArray(s.transactions) ? s.transactions : []).filter(t => t.status === 'open');
        const committed = open.reduce((a, t) => a + (t.model_stake_usd || 0), 0);
        const nextEnd = open.map(t => t.end_date).filter(Boolean).sort()[0];
        const hasCurve = Array.isArray(b.curve) && b.curve.length >= 2;
        const chart = hasCurve
            ? `<svg class="ora-line" id="ora-equity" viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="ora-eq-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><line class="ora-base" x1="0" x2="600" y1="0" y2="0" id="ora-eq-base"/><polygon class="area" points="" fill="url(#ora-eq-grad)"/><polyline class="ln" points=""/></svg>`
            : `<div class="ora-chart-empty">${esc(Lang.t('oracle.portfolio_waiting'))}</div>`;
        const refills = b.refills ? `<span class="oracle-chip warn">${b.refills} ${esc(Lang.t('oracle.refills'))}</span>` : '';
        const committedItem = committed > 0
            ? `<div><span class="ocm-l">${esc(Lang.t('oracle.committed'))}</span><span class="ocm-v mono">${committed.toFixed(2)}$</span></div>`
            : '';
        const pendingNote = open.length
            ? `<div class="oracle-note-info">${open.length} ${esc(Lang.t('oracle.open_bets')).toLowerCase()} · ${esc(Lang.t('oracle.awaiting_resolution'))}${nextEnd ? ' (' + this._shortDT(nextEnd) + '…)' : ''} — ${esc(Lang.t('oracle.moves_on_resolution'))}</div>`
            : '';
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.portfolio'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.portfolio_desc'))}</span></div>
            <div class="oracle-panel">
                <div class="oracle-chart-meta">
                    <div><span class="ocm-l">${esc(Lang.t('oracle.start'))}</span><span class="ocm-v mono">${this._num(b.start, 0)}$</span></div>
                    <div><span class="ocm-l">${esc(Lang.t('oracle.current'))}</span><span class="ocm-v mono">${this._num(b.final, 2)}$</span></div>
                    <div><span class="ocm-l">Net</span><span class="ocm-v mono ${b.net_pnl > 0 ? 'pos' : b.net_pnl < 0 ? 'neg' : ''}">${b.net_pnl != null ? (b.net_pnl > 0 ? '+' : '') + Number(b.net_pnl).toFixed(2) + '$' : '—'}</span></div>
                    ${committedItem}
                    ${refills}
                </div>
                <div class="ora-chart-box">${chart}</div>
                ${pendingNote}
                <div class="oracle-note-warn">${esc(Lang.t('oracle.portfolio_illustrative'))}</div>
            </div>
        </div>`;
    },

    // --- Analyses de marché : histogramme edges + calibration + near-misses
    _market(s) {
        const e = s.edges || {}, sh = s.shadow || {};
        const hist = Array.isArray(e.histogram) ? e.histogram : [];
        const cal = (sh.threshold_curve || []).filter(x => x.n_resolved > 0);
        const nm = (e.near_misses || []).slice(0, 6);

        const nmRows = nm.length
            ? nm.map(x => `<div class="t-row"><div><div class="t-name">${esc(x.question || '')}</div><div class="t-sub">${esc((x.side || '') + ' · ' + (x.asset || ''))}${(x.other_blockers && x.other_blockers.length) ? ' · ' + esc(x.other_blockers.join(',')) : ''}</div></div><div class="t-meta pos">${this._pct(x.edge_net)}</div></div>`).join('')
            : `<div class="oracle-empty-sm">${esc(Lang.t('oracle.no_positive_edge'))}</div>`;

        const calBlock = cal.length
            ? `<svg class="ora-bar" id="ora-calib" viewBox="0 0 320 160" preserveAspectRatio="none" aria-hidden="true"></svg><div class="ora-cal-legend">${cal.map(c => `<span class="mono">≥${(c.min_edge * 100).toFixed(0)}%: ${(c.avg_realized_edge * 100).toFixed(1)}% (n${c.n_resolved})</span>`).join('')}</div>`
            : `<div class="ora-chart-empty">${esc(Lang.t('oracle.calibration_waiting'))}</div>`;

        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.market'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.market_desc'))}</span></div>
            <div class="oracle-grid-2">
                <div class="oracle-panel">
                    <div class="oracle-panel-title">${esc(Lang.t('oracle.edge_distribution'))} <span class="opn">24h</span></div>
                    <div class="ora-chart-box sm"><svg class="ora-bar" id="ora-hist" viewBox="0 0 320 160" preserveAspectRatio="none" aria-hidden="true"></svg></div>
                    <div class="ora-hist-labels" id="ora-hist-labels"></div>
                </div>
                <div class="oracle-panel">
                    <div class="oracle-panel-title">${esc(Lang.t('oracle.calibration'))}</div>
                    <div class="ora-chart-box sm">${calBlock}</div>
                </div>
            </div>
            <div class="oracle-panel">
                <div class="oracle-panel-title">${esc(Lang.t('oracle.near_misses'))}</div>
                <div class="oracle-table">${nmRows}</div>
            </div>
        </div>`;
    },

    // --- Transactions : mon portefeuille (paper fantômes + alertes)
    _transactions(s) {
        const tx = Array.isArray(s.transactions) ? s.transactions : [];
        if (!tx.length) {
            return `<div class="oracle-section"><div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.transactions'))}</h3></div>
                <div class="oracle-panel"><div class="oracle-empty-sm">${esc(Lang.t('oracle.no_transactions'))}</div></div></div>`;
        }
        const rows = tx.slice(0, 40).map(t => {
            const st = { won: 'online', lost: 'danger', open: '' }[t.status] || '';
            const stLbl = { won: Lang.t('oracle.won'), lost: Lang.t('oracle.lost'), open: Lang.t('oracle.open_bets') }[t.status] || t.status;
            const pnl = t.pnl_usd != null ? `<span class="mono ${t.pnl_usd > 0 ? 'pos' : 'neg'}">${t.pnl_usd > 0 ? '+' : ''}${Number(t.pnl_usd).toFixed(2)}$</span>` : '<span class="mono">—</span>';
            return `<div class="t-row oracle-tx">
                <div><div class="t-name">${esc(t.question || '')}</div><div class="t-sub mono">${esc(t.ts_iso || '')} · ${esc(t.kind || '')}</div></div>
                <div class="t-meta">${esc(t.side || '')}</div>
                <div class="t-meta">${this._pct(t.edge_net)}</div>
                <div class="t-meta">${pnl}</div>
                <div><span class="badge ${st}">${esc(stLbl)}</span></div>
            </div>`;
        }).join('');
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.transactions'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.transactions_desc'))}</span></div>
            <div class="oracle-table with-head">
                <div class="t-head"><span>${esc(Lang.t('oracle.market_col'))}</span><span>${esc(Lang.t('oracle.side'))}</span><span>Edge</span><span>P&L</span><span>${esc(Lang.t('oracle.status'))}</span></div>
                ${rows}
            </div>
        </div>`;
    },

    // --- En-cours : pending par échéance + ordres réels (phase 3)
    _inProgress(s) {
        const pending = Array.isArray(s.pending) ? s.pending : [];
        const total = pending.reduce((a, p) => a + (p.count || 0), 0);
        const chips = pending.length
            ? pending.map(p => `<div class="oracle-pend"><span class="op-date mono">${esc((p.end_date || '').slice(5))}</span><span class="op-count mono">${p.count}</span></div>`).join('')
            : `<div class="oracle-empty-sm">${esc(Lang.t('oracle.none'))}</div>`;
        const orders = Array.isArray(s.orders) ? s.orders : [];
        const ordersBlock = orders.length
            ? orders.slice(0, 10).map(o => `<div class="t-row"><div class="t-name">${esc((o.question || '').slice(0, 50))}</div><div class="t-meta">${esc(o.side || '')}</div><div class="t-meta mono">${this._num(o.size_usd, 0)}$</div><div><span class="badge">${esc(o.status || '')}</span></div></div>`).join('')
            : `<div class="oracle-empty-sm">${esc(Lang.t('oracle.no_real_orders'))}</div>`;
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.in_progress'))}</h3><span class="oracle-sec-note">${total} ${esc(Lang.t('oracle.markets_tracked'))}</span></div>
            <div class="oracle-grid-2">
                <div class="oracle-panel"><div class="oracle-panel-title">${esc(Lang.t('oracle.pending_by_expiry'))}</div><div class="oracle-pend-row">${chips}</div></div>
                <div class="oracle-panel"><div class="oracle-panel-title">${esc(Lang.t('oracle.real_orders'))} <span class="opn">phase 3</span></div>${ordersBlock}</div>
            </div>
        </div>`;
    },

    _footer(s) {
        return `<div class="oracle-footer">${esc(Lang.t('oracle.generated'))}: <span class="mono">${esc(s.generated_iso || '')}</span></div>`;
    },

    // ============================================================
    // Oracle MK — portefeuille papier maker/taker (2026-07-30).
    //
    // Forme de snapshot totalement différente de la v1 (execution/rules/
    // verdict au lieu de health/bankroll/edges/transactions) → dashboard
    // dédié, indépendant de _dashboard(s) ci-dessus. Trois règles tournent
    // en parallèle : fade_maker et fade_taker partagent le même signal (seule
    // l'exécution diffère, ça isole l'effet maker) ; random_control est un
    // témoin aléatoire qui teste l'INSTRUMENT lui-même — s'il rapporte, le
    // simulateur ment et le verdict entier est invalide (verdict.reason ===
    // 'control_not_flat').
    //
    // Aujourd'hui, presque tout est à zéro (aucun marché résolu) : ce n'est
    // pas un cas limite, c'est l'état courant → chaque section doit rester
    // lisible avec des compteurs à 0 plutôt que de disparaître.
    // ============================================================

    _dashboardMk(s) {
        return [
            this._mkExecution(s),
            this._mkRace(s),
            this._mkGates(s),
            this._mkRareHits(s),
            this._mkBreakdowns(s),
            this._mkFooter(s),
        ].join('');
    },

    // --- 1. Bandeau exécution : LE chiffre du moment (taux de remplissage
    // maker). Ne dépend d'aucune résolution — dit seulement si fade_maker
    // est ne serait-ce qu'exécutable (un maker en fond de file ne se remplit
    // que si des preneurs balaient toute la file devant lui).
    _mkExecution(s) {
        const ex = s.execution || {};
        const maker = ex.fade_maker || {};
        const heroRate = maker.fill_rate_cons;
        const heroOk = heroRate !== null && heroRate !== undefined && !Number.isNaN(heroRate);
        const heroCls = heroOk && heroRate > 0 ? 'up' : '';
        const heroTxt = heroOk ? (Number(heroRate) * 100).toFixed(1) : '—';

        const overview = `<div class="bento-overview oracle-kpi">
            <div class="stat-card big">
                <span class="label">${esc(Lang.t('oracle.mk.hero_label'))}</span>
                <div class="value"><span class="delta ${heroCls}">${heroTxt}</span><span class="unit">%</span></div>
                <div class="footer">${this._num(maker.posted)} ${esc(Lang.t('oracle.mk.posted_short'))} · ${this._num(maker.filled_cons)} ${esc(Lang.t('oracle.mk.filled_short'))} · ${esc(Lang.t('oracle.mk.avg_queue'))} ${this._num(maker.avg_queue_ahead, 1)}</div>
            </div>
            <div class="stat-card"><span class="label">${esc(Lang.t('oracle.mk.rule_fade_taker'))}</span><div class="value">${this._mkPct((ex.fade_taker || {}).fill_rate_cons)}</div><div class="footer">${esc(Lang.t('oracle.mk.fill_rate'))}</div></div>
            <div class="stat-card"><span class="label">${esc(Lang.t('oracle.mk.rule_random_control'))}</span><div class="value">${this._mkPct((ex.random_control || {}).fill_rate_cons)}</div><div class="footer">${esc(Lang.t('oracle.mk.fill_rate'))}</div></div>
            <div class="stat-card"><span class="label">${esc(Lang.t('oracle.mk.avg_queue'))}</span><div class="value">${this._num(maker.avg_queue_ahead, 0)}</div><div class="footer">${esc(Lang.t('oracle.mk.rule_fade_maker'))}</div></div>
        </div>`;

        const rows = this._MK_RULE_KEYS.map(key => {
            const e = ex[key] || {};
            const placeable = e.placeable_at_real_bankroll;
            const sub = (placeable !== null && placeable !== undefined)
                ? `<div class="t-sub mono">${this._num(placeable)} ${esc(Lang.t('oracle.mk.placeable_short'))}</div>` : '';
            return `<div class="t-row oracle-mk-exec-row">
                <div><div class="t-name">${esc(Lang.t('oracle.mk.rule_' + key))}</div>${sub}</div>
                <div class="t-meta mono">${this._num(e.posted)}</div>
                <div class="t-meta mono">${this._num(e.filled_cons)}</div>
                <div class="t-meta">${this._mkPct(e.fill_rate_cons)}</div>
                <div class="t-meta mono">${this._num(e.avg_queue_ahead, 1)}</div>
            </div>`;
        }).join('');

        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.mk.execution_title'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.mk.execution_desc'))}</span></div>
            ${overview}
            <div class="oracle-table with-head oracle-mk-exec">
                <div class="t-head"><span>${esc(Lang.t('oracle.mk.col_rule'))}</span><span>${esc(Lang.t('oracle.mk.col_posted'))}</span><span>${esc(Lang.t('oracle.mk.col_filled'))}</span><span>${esc(Lang.t('oracle.mk.col_fill_rate'))}</span><span>${esc(Lang.t('oracle.mk.col_avg_queue'))}</span></div>
                ${rows}
            </div>
            <div class="oracle-note-info">${esc(Lang.t('oracle.mk.execution_note'))}</div>
        </div>`;
    },

    // --- 2. La course : P&L conservateur ET optimiste côte à côte par règle
    // (l'écart mesure la sensibilité au modèle de remplissage — jamais un seul
    // des deux) + remplissages résolus + clusters. random_control distingué
    // visuellement (bordure pointillée) : ce n'est pas une stratégie.
    _mkRace(s) {
        const rules = s.rules || {};
        const cards = this._MK_RULE_KEYS.map(key => {
            const r = rules[key] || {};
            const isControl = key === 'random_control';
            const ci = r.ci_cons || {};
            return `<div class="oracle-panel${isControl ? ' is-control' : ''}">
                <div class="oracle-panel-title">${esc(Lang.t('oracle.mk.rule_' + key))}</div>
                <div class="oracle-chart-meta">
                    <div><span class="ocm-l">${esc(Lang.t('oracle.mk.pnl_cons'))}</span><span class="ocm-v mono ${this._mkPnlCls(r.pnl_cons)}">${this._mkPnlTxt(r.pnl_cons)}</span></div>
                    <div><span class="ocm-l">${esc(Lang.t('oracle.mk.pnl_opt'))}</span><span class="ocm-v mono ${this._mkPnlCls(r.pnl_opt)}">${this._mkPnlTxt(r.pnl_opt)}</span></div>
                    <div><span class="ocm-l">${esc(Lang.t('oracle.mk.resolved'))}</span><span class="ocm-v mono">${this._num(r.n_cons)}</span></div>
                    <div><span class="ocm-l">${esc(Lang.t('oracle.mk.clusters'))}</span><span class="ocm-v mono">${this._num(ci.clusters)}</span></div>
                </div>
            </div>`;
        }).join('');
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.mk.race_title'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.mk.race_desc'))}</span></div>
            <div class="oracle-mk-rules">${cards}</div>
        </div>`;
    },

    // --- 3. Les portes du verdict : progrès vers 20 clusters, IC, DSR, raison
    // de blocage, par règle (fade_maker/fade_taker). La porte de VALIDITÉ
    // (le témoin reste-t-il plat ?) est traitée à part et prime sur tout —
    // si random_control gagne de l'argent dans notre simulateur, l'instrument
    // est faussé et rien d'autre n'est lisible.
    _mkGates(s) {
        const v = s.verdict || {};
        const byRule = v.by_rule || {};
        const control = v.control || {};
        const valid = v.valid !== false;
        const reason = v.reason || '';
        const isControlNotFlat = !valid && reason === 'control_not_flat';

        const controlLine = `${esc(Lang.t('oracle.mk.control_readout'))} ${esc(Lang.t('oracle.mk.clusters'))} ${this._num(control.clusters)}`
            + ` · IC [${this._num(control.lo, 4)}, ${this._num(control.hi, 4)}]`
            + ` · ${esc(Lang.t('oracle.mk.mean'))} ${this._num(control.mean, 4)}`;

        let validityBlock;
        if (!valid) {
            const body = isControlNotFlat
                ? esc(Lang.t('oracle.mk.invalid_control_not_flat'))
                : esc(reason ? reason : Lang.t('oracle.mk.invalid_generic'));
            validityBlock = `<div class="oracle-mk-alert">
                <div class="oracle-mk-alert-title">${esc(Lang.t('oracle.mk.invalid_title'))}</div>
                <div class="oracle-mk-alert-body">${body}</div>
                <div class="oracle-mk-alert-data mono">${controlLine}</div>
            </div>`;
        } else {
            validityBlock = `<div class="oracle-note-info">${esc(Lang.t('oracle.mk.valid_note'))} <span class="mono">${controlLine}</span></div>`;
        }

        const ruleBlocks = ['fade_maker', 'fade_taker'].map(key => {
            const r = byRule[key] || {};
            const ci = r.ci || {};
            const passed = !!r.passed;
            const reasonTxt = this._mkReasonLabel(r.reason);
            return `<div class="oracle-panel">
                <div class="oracle-panel-title">${esc(Lang.t('oracle.mk.rule_' + key))} <span class="badge ${passed ? 'online' : ''}">${esc(passed ? Lang.t('oracle.mk.gate_passed') : Lang.t('oracle.mk.gate_pending'))}</span></div>
                <div class="ov-bar-row"><span class="ov-lab mono">${esc(Lang.t('oracle.mk.clusters'))}</span>${this._progress(100 * ((r.clusters || 0) / 20))}<span class="ov-val mono">${this._num(r.clusters)}/20</span></div>
                <div class="t-sub mono">IC [${this._num(ci.lo, 4)}, ${this._num(ci.hi, 4)}] · ${esc(Lang.t('oracle.mk.mean'))} ${this._num(ci.mean, 4)} · DSR ${this._num(r.dsr, 3)}</div>
                ${(!passed && reasonTxt) ? `<div class="oracle-note-warn">${esc(reasonTxt)}</div>` : ''}
            </div>`;
        }).join('');

        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.mk.gates_title'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.mk.gates_desc'))}</span></div>
            ${validityBlock}
            <div class="oracle-grid-2">${ruleBlocks}</div>
        </div>`;
    },

    // Traduit un code de blocage par-règle (clusters/ci_includes_zero/dsr) ;
    // repli sur le code brut si inconnu (piège i18n #12 : Lang.t() renvoie la
    // clé elle-même si absente, jamais se fier à un `||` seul).
    _mkReasonLabel(reason) {
        if (!reason) return '';
        const key = 'oracle.mk.reason_' + reason;
        const t = Lang.t(key);
        return (t || '').startsWith('oracle.mk.reason_') ? reason : t;
    },

    // --- 4. Coups rares : une courbe de fade est belle jusqu'au premier
    // favori qui tombe — ce compteur ne doit jamais être caché.
    _mkRareHits(s) {
        const rules = s.rules || {};
        const rows = this._MK_RULE_KEYS.map(key => {
            const rh = (rules[key] || {}).rare_hits || {};
            return `<div class="t-row oracle-mk-rare-row">
                <div class="t-name">${esc(Lang.t('oracle.mk.rule_' + key))}</div>
                <div class="t-meta mono">${this._num(rh.count)}</div>
                <div class="t-meta"><span class="mono ${this._mkPnlCls(rh.pnl)}">${this._mkPnlTxt(rh.pnl)}</span></div>
            </div>`;
        }).join('');
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.mk.rare_title'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.mk.rare_desc'))}</span></div>
            <div class="oracle-table with-head oracle-mk-rare">
                <div class="t-head"><span>${esc(Lang.t('oracle.mk.col_rule'))}</span><span>${esc(Lang.t('oracle.mk.col_count'))}</span><span>P&L</span></div>
                ${rows}
            </div>
        </div>`;
    },

    // --- 5. Ventilations (by_shape/by_family/by_venue) : une seule si non
    // vide, par règle × dimension (forme de contrat/famille/place). Les
    // contrats one_touch se résolvent bien plus souvent que les
    // threshold_close, d'où leur séparation (légende by_shape).
    // Forme interne des entrées non garantie (le backend fait un passthrough
    // pur du JSON écrit par le projet Oracle, cf. oracle_router.py) → lecture
    // défensive avec repli n_cons/n puis pnl_cons/pnl.
    _mkBreakdowns(s) {
        const rules = s.rules || {};
        const DIMS = [
            ['by_shape', 'oracle.mk.by_shape', 'oracle.mk.by_shape_note'],
            ['by_family', 'oracle.mk.by_family', ''],
            ['by_venue', 'oracle.mk.by_venue', ''],
        ];
        const dimBlocks = DIMS.map(([dimKey, titleKey, noteKey]) => {
            const panels = this._MK_RULE_KEYS.map(ruleKey => {
                const data = (rules[ruleKey] || {})[dimKey];
                if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) return '';
                const rows = Object.keys(data).sort().map(subKey => {
                    const entry = data[subKey] || {};
                    const n = entry.n_cons !== undefined ? entry.n_cons : entry.n;
                    const pnl = entry.pnl_cons !== undefined ? entry.pnl_cons : entry.pnl;
                    return `<div class="t-row oracle-mk-rare-row">
                        <div class="t-name">${esc(String(subKey))}</div>
                        <div class="t-meta mono">${this._num(n)}</div>
                        <div class="t-meta"><span class="mono ${this._mkPnlCls(pnl)}">${this._mkPnlTxt(pnl)}</span></div>
                    </div>`;
                }).join('');
                return `<div class="oracle-panel">
                    <div class="oracle-panel-title">${esc(Lang.t('oracle.mk.rule_' + ruleKey))}</div>
                    <div class="oracle-table with-head oracle-mk-rare">
                        <div class="t-head"><span>${esc(Lang.t('oracle.mk.col_key'))}</span><span>${esc(Lang.t('oracle.mk.col_n'))}</span><span>P&L</span></div>
                        ${rows}
                    </div>
                </div>`;
            }).filter(Boolean).join('');
            if (!panels) return '';
            const note = noteKey ? `<span class="oracle-sec-note">${esc(Lang.t(noteKey))}</span>` : '';
            return `<div class="oracle-sec-head"><h3>${esc(Lang.t(titleKey))}</h3>${note}</div><div class="oracle-grid-2">${panels}</div>`;
        }).filter(Boolean).join('');
        if (!dimBlocks) return '';
        return `<div class="oracle-section">
            <div class="oracle-sec-head"><h3>${esc(Lang.t('oracle.mk.breakdowns_title'))}</h3><span class="oracle-sec-note">${esc(Lang.t('oracle.mk.breakdowns_desc'))}</span></div>
            ${dimBlocks}
        </div>`;
    },

    // --- 6. Pied de page : gel du pré-enregistrement, version du modèle,
    // note frais maker Kalshi si inconnus, alerte si le modèle a expiré.
    _mkFooter(s) {
        const expiredNote = s.expired ? `<div class="oracle-note-warn">${esc(Lang.t('oracle.mk.expired_note'))}</div>` : '';
        const feeNote = s.kalshi_maker_fee_unknown ? `<div class="oracle-note-warn">${esc(Lang.t('oracle.mk.kalshi_fee_note'))}</div>` : '';
        return `<div class="oracle-section">
            ${expiredNote}
            ${feeNote}
            <div class="oracle-footer">${esc(Lang.t('oracle.mk.model_version'))}: <span class="mono">${esc(s.model_version || '—')}</span> · ${esc(Lang.t('oracle.mk.prereg_frozen'))}: <span class="mono">${this._mkTs(s.prereg_ts)}</span> · ${esc(Lang.t('oracle.generated'))}: <span class="mono">${this._mkTs(s.ts)}</span></div>
        </div>`;
    },

    // Badge de la topbar pour la venue MK (health/executor_mode n'existent
    // pas dans ce schéma → remplacé par la validité du verdict, la donnée la
    // plus importante de cette vue).
    _topBadgeMk(snap) {
        const el = document.getElementById('oracle-top-right');
        if (!el) return;
        const v = snap.verdict || {};
        const valid = v.valid !== false;
        const cls = valid ? 'online' : 'danger';
        const lbl = valid ? Lang.t('oracle.mk.instrument_valid') : Lang.t('oracle.mk.instrument_invalid');
        el.innerHTML = `<span class="oracle-mode">${esc(Lang.t('oracle.mk.model_version_short'))}: <b>${esc(snap.model_version || '—')}</b></span><span class="badge ${cls}">${esc(lbl)}</span>`;
    },

    // --- Helpers numériques MK (ratio non-signé 0..1 et P&L signé $, formes
    // différentes de _pct()/toFixed inline utilisées par la v1) ---

    _mkPct(v) {
        if (v === null || v === undefined || Number.isNaN(v)) return '<span class="mono">—</span>';
        return `<span class="mono">${(Number(v) * 100).toFixed(1)}%</span>`;
    },

    _mkPnlCls(v) {
        if (v === null || v === undefined || Number.isNaN(v)) return '';
        return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    },

    _mkPnlTxt(v) {
        if (v === null || v === undefined || Number.isNaN(v)) return '—';
        return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '$';
    },

    // Timestamp unix (secondes, float) → "JJ/MM HH:MM" en heure locale du
    // navigateur (≠ _shortDT qui tranche une chaîne ISO déjà formatée : le
    // snapshot MK envoie des epochs bruts, pas d'ISO string).
    _mkTs(ts) {
        if (ts === null || ts === undefined || Number.isNaN(ts)) return '—';
        const d = new Date(Number(ts) * 1000);
        if (Number.isNaN(d.getTime())) return '—';
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    // ------------------------------------------------------- SVG charts

    _drawCharts(s) {
        try { this._drawEquity((s.bankroll || {}).curve); } catch (e) { }
        try { this._drawHistogram((s.edges || {}).histogram); } catch (e) { }
        try { this._drawCalibration((s.shadow || {}).threshold_curve); } catch (e) { }
    },

    _drawEquity(curve) {
        const svg = document.getElementById('ora-equity');
        if (!svg || !Array.isArray(curve) || curve.length < 2) return;
        const W = 600, H = 180, pad = 6;
        let min = Math.min(...curve), max = Math.max(...curve);
        if (max - min < 1) { const m = (max + min) / 2; min = m - 1; max = m + 1; }
        const step = W / (curve.length - 1);
        const y = v => (H - pad) - ((v - min) / (max - min)) * (H - 2 * pad);
        const pts = curve.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        const ln = svg.querySelector('.ln'), area = svg.querySelector('.area'), base = svg.querySelector('#ora-eq-base');
        if (ln) ln.setAttribute('points', pts);
        if (area) area.setAttribute('points', `0,${H} ${pts} ${W},${H}`);
        // Tracé Ion (omen-draw) : la courbe se dessine à l'entrée du dashboard.
        if (ln && this._isEntering() && !this._reducedMotion() && ln.getTotalLength) {
            try {
                const len = ln.getTotalLength();
                if (len > 0 && ln.animate) {
                    ln.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }],
                        { duration: 1400, delay: 300, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'backwards' });
                    if (area && area.animate) area.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 500, fill: 'backwards' });
                }
            } catch (e) { }
        }
        // ligne de référence = capital de départ (100$) si dans la plage
        if (base && curve.length) {
            const start = curve[0];
            if (start >= min && start <= max) { base.setAttribute('y1', y(start).toFixed(1)); base.setAttribute('y2', y(start).toFixed(1)); base.style.display = ''; }
            else base.style.display = 'none';
        }
    },

    _drawHistogram(hist) {
        const svg = document.getElementById('ora-hist');
        const labelsEl = document.getElementById('ora-hist-labels');
        if (!svg || !Array.isArray(hist) || !hist.length) return;
        const vals = hist.map(h => h[1] || 0);
        const labels = hist.map(h => h[0]);
        const W = 320, H = 160, gap = 4, n = vals.length;
        const bw = (W - gap * (n + 1)) / n, max = Math.max(...vals, 1);
        svg.innerHTML = vals.map((val, i) => {
            const h = (val / max) * (H - 20), x = gap + i * (bw + gap), yy = H - h;
            const neg = /<=0/.test(labels[i]);
            return `<rect class="bar ${neg ? 'neg' : ''}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" rx="2"/><text class="ora-barval" x="${(x + bw / 2).toFixed(1)}" y="${(yy - 3).toFixed(1)}" text-anchor="middle">${val || ''}</text>`;
        }).join('');
        if (labelsEl) labelsEl.innerHTML = labels.map(l => `<span>${esc(l.replace(' (seuil)', ''))}</span>`).join('');
    },

    _drawCalibration(curve) {
        const svg = document.getElementById('ora-calib');
        if (!svg) return;
        const cal = (curve || []).filter(x => x.n_resolved > 0);
        if (!cal.length) return;
        const W = 320, H = 160, gap = 6, n = cal.length;
        const bw = (W - gap * (n + 1)) / n;
        const vals = cal.map(c => c.avg_realized_edge);
        const maxAbs = Math.max(0.01, ...vals.map(v => Math.abs(v)));
        const zeroY = H / 2;
        svg.innerHTML = `<line class="ora-zero" x1="0" x2="${W}" y1="${zeroY}" y2="${zeroY}"/>` + cal.map((c, i) => {
            const v = c.avg_realized_edge;
            const h = (Math.abs(v) / maxAbs) * (H / 2 - 8);
            const x = gap + i * (bw + gap);
            const yy = v >= 0 ? zeroY - h : zeroY;
            return `<rect class="bar ${v < 0 ? 'neg' : ''}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" rx="2"/>`;
        }).join('');
    },
};
