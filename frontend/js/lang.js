/**
 * Lang.js — Système de traduction FR/EN.
 * 
 * Utilisation : Lang.t('sidebar.dashboard') → "Dashboard" ou "Tableau de bord"
 * Changer de langue : Lang.set('en') ou Lang.set('fr')
 * Langue actuelle : Lang.current
 */

const Lang = {
    current: localStorage.getItem('omen-lang') || 'fr',

    translations: {
        fr: {
            // Sidebar
            'sidebar.subtitle': 'Panel de gestion',
            'sidebar.general': 'Général',
            'sidebar.modules': 'Modules',
            'sidebar.system': 'Système',
            'sidebar.dashboard': 'Dashboard',
            'sidebar.game_servers': 'Serveurs de jeux',
            'sidebar.bots': 'Bots',
            'sidebar.files': 'Fichiers',
            'sidebar.media': 'Média',
            'sidebar.web': 'Web',
            'sidebar.network': 'Réseau',
            'sidebar.users': 'Utilisateurs',
            'sidebar.settings': 'Paramètres',
            'sidebar.theme': 'Changer de thème',
            'sidebar.lightmode': 'Mode clair/sombre',
            'sidebar.loading': 'Chargement...',

            // Login
            'login.username': "Nom d'utilisateur",
            'login.password': 'Mot de passe',
            'login.submit': 'Se connecter',
            'login.invite_question': "Tu as un code d'invitation ?",
            'login.create_account': 'Créer un compte →',
            'login.back': '← Retour à la connexion',
            'login.join_title': 'Rejoindre OmenServer',
            'login.invite_code': "Code d'invitation",
            'login.your_username': 'Ton pseudo',
            'login.create_my_account': 'Créer mon compte',
            'login.fill_all': 'Remplis tous les champs',
            'login.setup_welcome': 'Bienvenue ! 👋',
            'login.setup_subtitle': 'Première configuration de ton serveur',
            'login.setup_servername': 'Nom de ton serveur',
            'login.setup_next': 'Suivant →',
            'login.setup_create_admin': 'Crée ton compte admin',
            'login.setup_admin_subtitle': 'Ce sera le compte principal de ton serveur',
            'login.setup_confirm_password': 'Confirmer le mot de passe',
            'login.setup_create': 'Créer le compte →',
            'login.invite_enter': "Entre ton code d'invitation",
            'login.choose_username': "Choisis un nom d'utilisateur",
            'login.password_min': 'Le mot de passe doit faire au moins 4 caractères',
            'login.passwords_mismatch': 'Les mots de passe ne correspondent pas',
            'login.enter_username': "Entre un nom d'utilisateur",
            'login.server_error': 'Erreur de connexion au serveur',
            'login.signup_error': "Erreur lors de l'inscription",
            'login.invite_valid': 'Invitation valide — Rôle :',
            'login.invite_invalid': 'Code invalide',

            // Dashboard
            'dashboard.title': 'Dashboard',
            'dashboard.cpu': 'CPU',
            'dashboard.ram': 'RAM',
            'dashboard.disk': 'Disque',
            'dashboard.temp': 'Température',
            'dashboard.network': 'Réseau',
            'dashboard.system_info': 'Infos Système',

            // Toast / Alerts
            'toast.light_on': '☀️ Mode clair activé',
            'toast.light_off': '🌙 Mode sombre activé',
            'toast.theme': 'Thème :',
            'toast.logout': 'Déconnecté',

            // Common
            'common.logout': 'Déconnexion',
            'common.cancel': 'Annuler',
            'common.save': 'Sauvegarder',
            'common.delete': 'Supprimer',
            'common.start': 'Démarrer',
            'common.stop': 'Arrêter',
            'common.restart': 'Redémarrer',
            'common.refresh': 'Rafraîchir',
            'common.close': 'Fermer',
            'common.yes': 'Oui',
            'common.no': 'Non',
            'common.error': 'Erreur',
            'common.success': 'Succès',
            'common.loading': 'Chargement...',
            'common.admin': 'Administrateur',
        },

        en: {
            // Sidebar
            'sidebar.subtitle': 'Management Panel',
            'sidebar.general': 'General',
            'sidebar.modules': 'Modules',
            'sidebar.system': 'System',
            'sidebar.dashboard': 'Dashboard',
            'sidebar.game_servers': 'Game Servers',
            'sidebar.bots': 'Bots',
            'sidebar.files': 'Files',
            'sidebar.media': 'Media',
            'sidebar.web': 'Web',
            'sidebar.network': 'Network',
            'sidebar.users': 'Users',
            'sidebar.settings': 'Settings',
            'sidebar.theme': 'Change theme',
            'sidebar.lightmode': 'Light/dark mode',
            'sidebar.loading': 'Loading...',

            // Login
            'login.username': 'Username',
            'login.password': 'Password',
            'login.submit': 'Sign in',
            'login.invite_question': 'Have an invite code?',
            'login.create_account': 'Create account →',
            'login.back': '← Back to login',
            'login.join_title': 'Join OmenServer',
            'login.invite_code': 'Invite code',
            'login.your_username': 'Your username',
            'login.create_my_account': 'Create my account',
            'login.fill_all': 'Fill in all fields',
            'login.setup_welcome': 'Welcome! 👋',
            'login.setup_subtitle': 'First-time server setup',
            'login.setup_servername': 'Server name',
            'login.setup_next': 'Next →',
            'login.setup_create_admin': 'Create your admin account',
            'login.setup_admin_subtitle': 'This will be your server\'s main account',
            'login.setup_confirm_password': 'Confirm password',
            'login.setup_create': 'Create account →',
            'login.invite_enter': 'Enter your invite code',
            'login.choose_username': 'Choose a username',
            'login.password_min': 'Password must be at least 4 characters',
            'login.passwords_mismatch': 'Passwords do not match',
            'login.enter_username': 'Enter a username',
            'login.server_error': 'Server connection error',
            'login.signup_error': 'Error creating account',
            'login.invite_valid': 'Valid invite — Role:',
            'login.invite_invalid': 'Invalid code',

            // Dashboard
            'dashboard.title': 'Dashboard',
            'dashboard.cpu': 'CPU',
            'dashboard.ram': 'RAM',
            'dashboard.disk': 'Disk',
            'dashboard.temp': 'Temperature',
            'dashboard.network': 'Network',
            'dashboard.system_info': 'System Info',

            // Toast / Alerts
            'toast.light_on': '☀️ Light mode enabled',
            'toast.light_off': '🌙 Dark mode enabled',
            'toast.theme': 'Theme:',
            'toast.logout': 'Logged out',

            // Common
            'common.logout': 'Logout',
            'common.cancel': 'Cancel',
            'common.save': 'Save',
            'common.delete': 'Delete',
            'common.start': 'Start',
            'common.stop': 'Stop',
            'common.restart': 'Restart',
            'common.refresh': 'Refresh',
            'common.close': 'Close',
            'common.yes': 'Yes',
            'common.no': 'No',
            'common.error': 'Error',
            'common.success': 'Success',
            'common.loading': 'Loading...',
            'common.admin': 'Administrator',
        },
    },

    /**
     * Récupérer une traduction par clé.
     * @param {string} key - Clé de traduction (ex: 'sidebar.dashboard')
     * @returns {string} Texte traduit ou la clé si non trouvée
     */
    t(key) {
        return this.translations[this.current]?.[key] || this.translations['fr']?.[key] || key;
    },

    /**
     * Changer la langue et rafraîchir l'interface.
     * @param {string} lang - 'fr' ou 'en'
     */
    set(lang) {
        if (!this.translations[lang]) return;
        this.current = lang;
        localStorage.setItem('omen-lang', lang);
        // Rafraîchir les éléments statiques de la sidebar
        this._updateSidebar();
        if (typeof Toast !== 'undefined') {
            Toast.info(lang === 'fr' ? '🇫🇷 Français activé' : '🇬🇧 English enabled');
        }
    },

    /**
     * Met à jour les textes statiques de la sidebar (index.html).
     */
    _updateSidebar() {
        const mappings = {
            '.sidebar-subtitle': 'sidebar.subtitle',
        };
        // Section labels
        const labels = document.querySelectorAll('.nav-section-label');
        if (labels[0]) labels[0].textContent = this.t('sidebar.general');
        if (labels[1]) labels[1].textContent = this.t('sidebar.modules');
        if (labels[2]) labels[2].textContent = this.t('sidebar.system');

        // Nav items (text nodes after the icon span)
        const items = {
            'hub': 'sidebar.dashboard',
            'game_server': 'sidebar.game_servers',
            'bots': 'sidebar.bots',
            'files': 'sidebar.files',
            'media': 'sidebar.media',
            'web': 'sidebar.web',
            'network': 'sidebar.network',
            'users': 'sidebar.users',
            'settings': 'sidebar.settings',
        };
        Object.entries(items).forEach(([view, key]) => {
            const el = document.querySelector(`[data-view="${view}"]`);
            if (el) {
                const icon = el.querySelector('.nav-item-icon');
                if (icon) {
                    el.textContent = '';
                    el.appendChild(icon);
                    el.appendChild(document.createTextNode(' ' + this.t(key)));
                }
            }
        });

        // Subtitle
        const sub = document.querySelector('.sidebar-subtitle');
        if (sub) sub.textContent = this.t('sidebar.subtitle');

        // Theme buttons
        const themeBtn = document.getElementById('theme-btn');
        if (themeBtn) themeBtn.title = this.t('sidebar.theme');
        const lmBtn = document.getElementById('lightmode-btn');
        if (lmBtn) lmBtn.title = this.t('sidebar.lightmode');
    },

    /**
     * Basculer entre FR et EN.
     */
    toggle() {
        this.set(this.current === 'fr' ? 'en' : 'fr');
    },
};
