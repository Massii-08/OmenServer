/**
 * Auth.js — Gestion de l'authentification côté frontend.
 * 
 * Ce fichier gère :
 * - Le stockage du token JWT dans localStorage
 * - L'envoi du token à chaque requête API
 * - La vérification de connexion
 * - Le login, register et logout
 * - La gestion des erreurs réseau (serveur down, timeout, etc.)
 */

const Auth = {
    TOKEN_KEY: 'omenserver_token',
    USER_KEY: 'omenserver_user',

    /**
     * Sauvegarde le token et les infos user après login/register.
     */
    setSession(token, user) {
        localStorage.setItem(this.TOKEN_KEY, token);
        localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    },

    /**
     * Récupère le token stocké.
     */
    getToken() {
        return localStorage.getItem(this.TOKEN_KEY);
    },

    /**
     * Récupère les infos de l'utilisateur connecté.
     */
    getUser() {
        const data = localStorage.getItem(this.USER_KEY);
        return data ? JSON.parse(data) : null;
    },

    /**
     * Vérifie si l'utilisateur est connecté (token présent).
     */
    isLoggedIn() {
        return !!this.getToken();
    },

    /**
     * Déconnexion : supprime le token et redirige vers le login.
     */
    logout() {
        // Appeler l'API logout (non bloquant)
        const token = this.getToken();
        if (token) {
            fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
            }).catch(() => {}); // On ignore les erreurs
        }

        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.USER_KEY);
        window.location.href = '/login';
    },

    /**
     * Affiche une notification d'erreur réseau en haut de l'écran.
     */
    _networkErrorVisible: false,
    showNetworkError() {
        if (this._networkErrorVisible) return;
        this._networkErrorVisible = true;

        const banner = document.createElement('div');
        banner.id = 'network-error-banner';
        banner.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
            background: #e74c3c; color: white; padding: 10px 20px;
            text-align: center; font-size: 13px; font-weight: 600;
            animation: fadeIn 0.3s ease;
        `;
        banner.textContent = '⚠️ Connexion au serveur perdue. Vérification en cours...';
        document.body.appendChild(banner);

        // Réessayer toutes les 3 secondes
        const retry = setInterval(async () => {
            try {
                const res = await fetch('/api/health');
                if (res.ok) {
                    clearInterval(retry);
                    banner.style.background = '#2ecc71';
                    banner.textContent = '✅ Connexion rétablie !';
                    setTimeout(() => {
                        banner.remove();
                        this._networkErrorVisible = false;
                    }, 2000);
                }
            } catch (_) {}
        }, 3000);
    },

    /**
     * Fait une requête API authentifiée.
     * Ajoute automatiquement le token dans les headers.
     * Gère les erreurs réseau et l'expiration de token.
     */
    async apiCall(url, options = {}) {
        const token = this.getToken();
        const isFormData = options.body instanceof FormData;
        const headers = {
            ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {}),
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(url, { ...options, headers });

            // Si 401 (non autorisé), le token est expiré → message + déconnexion
            if (response.status === 401) {
                if (typeof Toast !== 'undefined') Toast.warn('Ta session a expiré. Reconnecte-toi.');
                else alert('Ta session a expiré. Reconnecte-toi.');
                this.logout();
                return null;
            }

            return response;
        } catch (error) {
            console.error('Erreur API:', error);
            // Afficher la bannière de perte de connexion
            this.showNetworkError();
            return null;
        }
    },

    /**
     * Login avec username + password.
     */
    async login(username, password) {
        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
            });

            if (!response.ok) {
                const err = await response.json();
                return { success: false, error: err.detail || 'Erreur de connexion' };
            }

            const data = await response.json();
            this.setSession(data.access_token, data.user);
            return { success: true };

        } catch (error) {
            return { success: false, error: 'Impossible de contacter le serveur. Vérifie qu\'il est bien lancé.' };
        }
    },

    /**
     * Register (premier compte uniquement — setup wizard).
     */
    async register(username, password, serverName) {
        try {
            const response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    server_name: serverName,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                return { success: false, error: err.detail || 'Erreur lors de l\'inscription' };
            }

            const data = await response.json();
            this.setSession(data.access_token, data.user);
            return { success: true };

        } catch (error) {
            return { success: false, error: 'Impossible de contacter le serveur. Vérifie qu\'il est bien lancé.' };
        }
    },

    /**
     * Vérifie si c'est la première configuration (aucun utilisateur).
     */
    async checkSetupNeeded() {
        try {
            const response = await fetch('/api/auth/setup-needed');
            const data = await response.json();
            return data.setup_needed;
        } catch {
            return false;
        }
    },
};
