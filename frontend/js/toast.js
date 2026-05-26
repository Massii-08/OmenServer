/**
 * Toast.js — Système de notifications toast (Bento Tech v5).
 *
 * Replace alert() / confirm() natifs par des toasts animés.
 * Refacto PR20 : utilise la classe `.toast` définie dans style.css (Bento)
 * au lieu d'inline-styler. Aucun backdrop-filter / box-shadow flou
 * (MASTER §6).
 *
 * Usage:
 *   Toast.success('Sauvegarde créée !')
 *   Toast.error('Erreur de connexion')
 *   Toast.info('Chargement en cours...')
 *   Toast.warn('Attention: le serveur est arrêté')
 */
const Toast = {
    _container: null,

    _init() {
        if (this._container) return;
        this._container = document.createElement('div');
        this._container.id = 'toast-container';
        // Positioning only — visual styling vient des classes .toast en CSS
        this._container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:380px;';
        document.body.appendChild(this._container);
    },

    /**
     * Affiche un toast.
     * @param {string} message - Le message
     * @param {string} type - success|error|info|warn
     * @param {number} duration - Durée en ms (default 3500)
     */
    show(message, type = 'info', duration = 3500) {
        this._init();

        // Icons functional (status indicators kept per MASTER chip exception)
        const icons = { success: '', error: '', info: 'ℹ', warn: '' };
        // CSS expects 'warning' not 'warn' for the .toast.warning selector
        const cssType = type === 'warn' ? 'warning' : type;

        const toast = document.createElement('div');
        toast.className = 'toast ' + cssType;
        // Minimal inline : padding + flex + animation hooks (le visuel = classe)
        toast.style.cssText = `
            display:flex;align-items:center;gap:10px;
            padding:14px 18px;
            font-size:13px;
            pointer-events:auto;
            cursor:pointer;
            transform:translateX(120%);
            transition:transform 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.35s ease;
            opacity:0;
        `;
        toast.innerHTML = `
            <span style="font-size:14px;flex-shrink:0;line-height:1;">${icons[type]}</span>
            <span style="flex:1;line-height:1.4;">${message}</span>
            <span style="font-size:14px;color:var(--text-dim);flex-shrink:0;"></span>
        `;

        // Click to dismiss
        toast.addEventListener('click', () =>this._dismiss(toast));

        this._container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() =>{
            toast.style.transform = 'translateX(0)';
            toast.style.opacity = '1';
        });

        // Auto dismiss
        const timer = setTimeout(() =>this._dismiss(toast), duration);
        toast._timer = timer;
    },

    _dismiss(toast) {
        if (toast._dismissed) return;
        toast._dismissed = true;
        clearTimeout(toast._timer);
        toast.style.transform = 'translateX(120%)';
        toast.style.opacity = '0';
        setTimeout(() =>toast.remove(), 400);
    },

    success(msg, duration) { this.show(msg, 'success', duration); },
    error(msg, duration)   { this.show(msg, 'error', duration); },
    info(msg, duration)    { this.show(msg, 'info', duration); },
    warn(msg, duration)    { this.show(msg, 'warn', duration); },
};
