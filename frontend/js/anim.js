/**
 * anim.js — Micro-animations & « vie » du site (Bento Tech v5).
 *
 * Pur vanilla, ZÉRO dépendance. Respecte `prefers-reduced-motion`.
 * Exposé en global : `Anim`.
 *
 * Conforme MASTER : durées courtes, easing doux, pas de blur/gradient/glow.
 * Le visuel (keyframes, classes) vit dans style.css — ce fichier ne fait
 * qu'orchestrer (entrée de page, count-up, skeleton de chargement).
 */
const Anim = {
    /** true si l'utilisateur a demandé la réduction des animations (OS/navigateur). */
    reduced: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),

    _enterTimer: null,

    /**
     * Rejoue l'animation d'entrée du conteneur principal à chaque navigation.
     * Pose `.view-enter` sur #module-content (les cartes décalent via CSS),
     * puis la retire après 1 s pour ne PAS ré-animer aux refresh internes
     * (le poll monitoring réécrit `nodes-grid` toutes les ~20-30 s).
     */
    pageEnter() {
        if (this._navMove) requestAnimationFrame(this._navMove);
        if (this.reduced) return;
        const c = document.getElementById('module-content');
        if (!c) return;
        c.classList.remove('view-enter');
        void c.offsetWidth;              // force reflow → redémarre l'animation
        c.classList.add('view-enter');
        clearTimeout(this._enterTimer);
        // 1200 ms : dernier délai .42s + durée .65s = 1070 ms (couper à 1s tranchait le settle)
        this._enterTimer = setTimeout(() => c.classList.remove('view-enter'), 1200);
    },

    /**
     * Compte de 0 jusqu'à `to` dans l'élément. Réduit → set direct.
     * @param {HTMLElement} el
     * @param {number} to
     * @param {number} [duration=900] ms
     */
    countUp(el, to, duration) {
        if (!el) return;
        to = Math.round(Number(to) || 0);
        if (this.reduced) { el.textContent = to; return; }
        duration = duration || 900;
        if (el._animRAF) cancelAnimationFrame(el._animRAF);
        const start = performance.now();
        const ease = (p) => 1 - Math.pow(1 - p, 3);   // easeOutCubic
        const tick = (now) => {
            const p = Math.min(1, (now - start) / duration);
            el.textContent = Math.round(to * ease(p));
            if (p < 1) {
                el._animRAF = requestAnimationFrame(tick);
            } else {
                el._animRAF = null;
                el.textContent = to;
            }
        };
        el._animRAF = requestAnimationFrame(tick);
    },

    /**
     * Renvoie le HTML d'un skeleton shimmer (placeholder de chargement).
     * @param {('card'|'row'|'line')} [kind='card']
     * @param {number} [count=3]
     * @returns {string}
     */
    skeleton(kind, count) {
        kind = kind || 'card';
        count = count || 3;
        const cls = kind === 'row' ? 'skel skel-row'
                  : kind === 'line' ? 'skel skel-line'
                  : 'skel skel-card';
        let out = '';
        for (let i = 0; i < count; i++) out += `<div class="${cls}"></div>`;
        return `<div class="skel-wrap">${out}</div>`;
    },

    /**
     * Indicateur morphing de la topbar : un pill .nav-ind glisse sous l'onglet
     * actif (et suit le survol). Créé une seule fois, idempotent.
     * Reduced-motion : le CSS neutralise la transition (saut instantané, OK).
     */
    _navMove: null,

    navInit() {
        const tabs = document.getElementById('nav-tabs');
        if (!tabs || tabs.querySelector('.nav-ind')) return;
        const ind = document.createElement('span');
        ind.className = 'nav-ind';
        ind.setAttribute('aria-hidden', 'true');
        tabs.prepend(ind);
        const move = (el) => {
            if (!el) { ind.classList.remove('on'); return; }
            ind.style.left = el.offsetLeft + 'px';
            ind.style.width = el.offsetWidth + 'px';
            ind.classList.add('on');
        };
        const active = () => tabs.querySelector('.nav-tab.active');
        tabs.addEventListener('mouseover', (e) => {
            const t = e.target.closest('.nav-tab');
            if (t) move(t);
        });
        tabs.addEventListener('mouseleave', () => move(active()));
        this._navMove = () => move(active());
        window.addEventListener('resize', this._navMove);
        this._navMove();
        // Geist charge en async : les largeurs d'onglets bougent au font-swap
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => { if (this._navMove) this._navMove(); });
        }
    },
};
