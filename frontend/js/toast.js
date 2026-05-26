/**
 * Toast.js — Système de notifications toast.
 * 
 * Remplace les alert() et confirm() natifs par des toasts animés.
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

        const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
        const colors = {
            success: { bg: 'rgba(74,222,128,0.15)', border: 'rgba(74,222,128,0.4)', text: 'var(--accent)' },
            error:   { bg: 'rgba(248,113,113,0.15)', border: 'rgba(248,113,113,0.4)', text: 'var(--danger)' },
            info:    { bg: 'rgba(96,165,250,0.15)', border: 'rgba(96,165,250,0.4)', text: 'var(--info)' },
            warn:    { bg: 'rgba(251,191,36,0.15)', border: 'rgba(251,191,36,0.4)', text: 'var(--warning)' },
        };
        const c = colors[type] || colors.info;

        const toast = document.createElement('div');
        toast.style.cssText = `
            display:flex;align-items:center;gap:10px;
            padding:14px 18px;
            background:${c.bg};
            backdrop-filter:blur(12px);
            border:1px solid ${c.border};
            border-radius:12px;
            color:#e8e8f0;
            font-size:13px;
            font-family:'Inter',sans-serif;
            pointer-events:auto;
            cursor:pointer;
            box-shadow:0 8px 32px rgba(0,0,0,0.3);
            transform:translateX(120%);
            transition:transform 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.35s ease;
            opacity:0;
        `;
        toast.innerHTML = `
            <span style="font-size:18px;flex-shrink:0;">${icons[type]}</span>
            <span style="flex:1;line-height:1.4;">${message}</span>
            <span style="font-size:16px;opacity:0.5;flex-shrink:0;">✕</span>
        `;

        // Click to dismiss
        toast.addEventListener('click', () => this._dismiss(toast));

        this._container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(0)';
            toast.style.opacity = '1';
        });

        // Auto dismiss
        const timer = setTimeout(() => this._dismiss(toast), duration);
        toast._timer = timer;
    },

    _dismiss(toast) {
        if (toast._dismissed) return;
        toast._dismissed = true;
        clearTimeout(toast._timer);
        toast.style.transform = 'translateX(120%)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    },

    success(msg, duration) { this.show(msg, 'success', duration); },
    error(msg, duration)   { this.show(msg, 'error', duration); },
    info(msg, duration)    { this.show(msg, 'info', duration); },
    warn(msg, duration)    { this.show(msg, 'warn', duration); },
};
