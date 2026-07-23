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
    _venue: 'polymarket',

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
                            <div class="oracle-sub">${esc(Lang.t('oracle.subtitle'))}</div>
                        </div>
                    </div>
                    <div class="lang-switcher oracle-venues" id="oracle-venues">
                        <button class="lang" data-venue="polymarket" onclick="OracleModule._setVenue('polymarket')">Polymarket</button>
                        <button class="lang" data-venue="kalshi" onclick="OracleModule._setVenue('kalshi')">Kalshi</button>
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
        if (v === this._venue || (v !== 'polymarket' && v !== 'kalshi')) return;
        this._venue = v;
        this._syncVenuePills();
        const body = document.getElementById('oracle-body');
        if (body) body.innerHTML = `<div class="oracle-loading">${esc(Lang.t('common.loading'))}</div>`;
        this._load();
    },

    _syncVenuePills() {
        const wrap = document.getElementById('oracle-venues');
        if (!wrap) return;
        wrap.querySelectorAll('.lang').forEach(b =>
            b.classList.toggle('active', b.dataset.venue === this._venue));
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
        body.innerHTML = this._dashboard(this._snap);
        this._topBadge(this._snap);
        this._drawCharts(this._snap);
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
        const h = snap.health || {};
        const cls = { ok: 'online', warn: 'warn', error: 'danger' }[h.status] || '';
        const lbl = { ok: 'LIVE', warn: Lang.t('oracle.degraded'), error: 'STALE', unknown: '—' }[h.status] || '—';
        const mode = esc(h.executor_mode || 'paper');
        el.innerHTML = `<span class="oracle-mode">${esc(Lang.t('oracle.mode'))}: <b>${mode}</b></span><span class="badge ${cls}">${esc(lbl)}</span>`;
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
        const items = [
            { l: Lang.t('oracle.cycles_24h'), v: h.cycles_24h ?? '—' },
            { l: Lang.t('oracle.last_cycle'), v: h.last_cycle_age_min != null ? h.last_cycle_age_min + ' min' : '—', warn: (h.last_cycle_age_min || 0) > 95 },
            { l: 'Degraded', v: h.degraded_cycles ?? 0, err: (h.degraded_cycles || 0) >= 3, warn: (h.degraded_cycles || 0) > 0 },
            { l: Lang.t('oracle.executor'), v: h.executor_mode || 'paper' },
        ];
        const cells = items.map(i => `<div class="diag-item ${i.err ? 'err' : i.warn ? 'warn' : ''}"><span class="d-l">${esc(i.l)}</span><span class="d-v">${esc(String(i.v))}</span></div>`).join('');
        const nPct = v.pct_n ?? 0, cPct = v.pct_clusters ?? 0;
        const statusTxt = { ok: Lang.t('oracle.healthy'), warn: Lang.t('oracle.degraded'), error: Lang.t('oracle.stale'), unknown: '—' }[h.status] || '—';
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
