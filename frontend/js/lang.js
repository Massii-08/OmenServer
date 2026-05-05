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
            'dashboard.memory': 'Mémoire RAM',
            'dashboard.disk': 'Disque',
            'dashboard.temp': 'Température',
            'dashboard.network': 'Réseau',
            'dashboard.system_info': 'Infos Système',
            'dashboard.overview': 'Vue d\'ensemble de ton serveur',
            'dashboard.kill_all': 'Kill All',
            'dashboard.diagnostic': 'Diagnostic',
            'dashboard.quick_actions': 'Actions rapides',
            'dashboard.analyzing': '🩺 Analyse en cours...',
            'dashboard.diag_error': '❌ Erreur de diagnostic',
            'dashboard.all_good': '🟢 Tout va bien',
            'dashboard.attention': '🟡 Attention requise',
            'dashboard.problems': '🔴 Problèmes détectés',
            'dashboard.warnings': 'avertissement(s)',
            'dashboard.criticals': 'critique(s)',

            // Modules hub
            'modules.title': 'Modules',
            'modules.active': 'Actif',
            'modules.soon': 'Bientôt',
            'modules.game_servers': 'Serveurs de jeux',
            'modules.game_servers_desc': 'Gérer tes serveurs Minecraft, ARK et autres jeux',
            'modules.bots': 'Bots & Automatisation',
            'modules.bots_desc': 'Déployer et monitorer tes bots Python',
            'modules.files': 'Fichiers & Cloud',
            'modules.files_desc': 'Cloud personnel + sync Google Drive',
            'modules.media': 'Média & Streaming',
            'modules.media_desc': 'Serveur Jellyfin pour tes films et séries',
            'modules.web': 'Serveur Web',
            'modules.web_desc': 'Héberger des sites web et APIs via Docker',
            'modules.network': 'Monitoring Réseau',
            'modules.network_desc': 'Surveillance réseau + Wake-on-LAN',

            // Scheduler
            'scheduler.title': '📅 Planification globale',
            'scheduler.subtitle': 'Tâches planifiées sur tous les serveurs',
            'scheduler.loading': '⏳ Chargement des tâches...',
            'scheduler.no_tasks': 'Aucune tâche planifiée',
            'scheduler.create': 'Créer une tâche',
            'scheduler.new_task': 'Nouvelle tâche',
            'scheduler.server': 'Serveur',
            'scheduler.type': 'Type',
            'scheduler.interval': 'Intervalle',
            'scheduler.add': 'Ajouter',
            'scheduler.backup': 'Backup auto',
            'scheduler.restart': 'Restart auto',
            'scheduler.week': '1 semaine',
            'scheduler.tasks_count': 'tâche(s) sur',
            'scheduler.servers_count': 'serveur(s)',
            'scheduler.every': 'toutes les',
            'scheduler.active': 'Actif',
            'scheduler.inactive': 'Inactif',
            'scheduler.created': '✅ Tâche créée !',
            'scheduler.select_server': '❌ Sélectionne un serveur',
            'scheduler.no_servers': 'Aucun serveur',

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

            // Bots
            'bots.title': '🤖 Bots & Automatisation',
            'bots.subtitle': 'Déployer et monitorer tes bots Python',
            'bots.new': 'Nouveau bot',
            'bots.create': 'Créer un bot',
            'bots.name': 'Nom du bot',
            'bots.type': 'Type',
            'bots.description': 'Description',
            'bots.none': 'Aucun bot',
            'bots.none_hint': 'Clique sur "Nouveau bot" pour commencer',
            'bots.running': '● En cours',
            'bots.stopped': '○ Arrêté',
            'bots.error': '⚠️ Erreur',
            'bots.no_desc': 'Pas de description',
            'bots.name_required': '❌ Nom requis',
            'bots.delete_confirm': 'Supprimer ce bot ?',
            'bots.logs': 'Logs',
            'bots.lines': 'ligne(s)',
            'bots.no_logs': 'Aucun log disponible — Démarre le bot pour voir les logs ici',
            'bots.editor': '✏️ Éditeur',
            'bots.save_hint': 'Ctrl+S pour sauvegarder',
            'bots.saved': '✅ Sauvegardé !',
            'bots.loading': '⏳ Chargement des bots...',
            'bots.analysis': 'Analyse',

            // Settings
            'settings.title': '⚙️ Paramètres',
            'settings.users': '👥 Utilisateurs',
            'settings.language': '🌐 Langue',
            'settings.lang_desc': 'Choisir la langue de l\'interface',
            'settings.french': '🇫🇷 Français',
            'settings.english': '🇬🇧 English',
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
            'dashboard.memory': 'Memory',
            'dashboard.disk': 'Disk',
            'dashboard.temp': 'Temperature',
            'dashboard.network': 'Network',
            'dashboard.system_info': 'System Info',
            'dashboard.overview': 'Server overview',
            'dashboard.kill_all': 'Kill All',
            'dashboard.diagnostic': 'Diagnostic',
            'dashboard.quick_actions': 'Quick actions',
            'dashboard.analyzing': '🩺 Analyzing...',
            'dashboard.diag_error': '❌ Diagnostic error',
            'dashboard.all_good': '🟢 All systems go',
            'dashboard.attention': '🟡 Attention required',
            'dashboard.problems': '🔴 Problems detected',
            'dashboard.warnings': 'warning(s)',
            'dashboard.criticals': 'critical(s)',

            // Modules hub
            'modules.title': 'Modules',
            'modules.active': 'Active',
            'modules.soon': 'Soon',
            'modules.game_servers': 'Game Servers',
            'modules.game_servers_desc': 'Manage your Minecraft, ARK and other game servers',
            'modules.bots': 'Bots & Automation',
            'modules.bots_desc': 'Deploy and monitor your Python bots',
            'modules.files': 'Files & Cloud',
            'modules.files_desc': 'Personal cloud + Google Drive sync',
            'modules.media': 'Media & Streaming',
            'modules.media_desc': 'Jellyfin server for movies and series',
            'modules.web': 'Web Server',
            'modules.web_desc': 'Host websites and APIs via Docker',
            'modules.network': 'Network Monitoring',
            'modules.network_desc': 'Network monitoring + Wake-on-LAN',

            // Scheduler
            'scheduler.title': '📅 Global Scheduling',
            'scheduler.subtitle': 'Scheduled tasks across all servers',
            'scheduler.loading': '⏳ Loading tasks...',
            'scheduler.no_tasks': 'No scheduled tasks',
            'scheduler.create': 'Create task',
            'scheduler.new_task': 'New task',
            'scheduler.server': 'Server',
            'scheduler.type': 'Type',
            'scheduler.interval': 'Interval',
            'scheduler.add': 'Add',
            'scheduler.backup': 'Auto backup',
            'scheduler.restart': 'Auto restart',
            'scheduler.week': '1 week',
            'scheduler.tasks_count': 'task(s) on',
            'scheduler.servers_count': 'server(s)',
            'scheduler.every': 'every',
            'scheduler.active': 'Active',
            'scheduler.inactive': 'Inactive',
            'scheduler.created': '✅ Task created!',
            'scheduler.select_server': '❌ Select a server',
            'scheduler.no_servers': 'No servers',

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

            // Bots
            'bots.title': '🤖 Bots & Automation',
            'bots.subtitle': 'Deploy and monitor your Python bots',
            'bots.new': 'New bot',
            'bots.create': 'Create a bot',
            'bots.name': 'Bot name',
            'bots.type': 'Type',
            'bots.description': 'Description',
            'bots.none': 'No bots',
            'bots.none_hint': 'Click "New bot" to get started',
            'bots.running': '● Running',
            'bots.stopped': '○ Stopped',
            'bots.error': '⚠️ Error',
            'bots.no_desc': 'No description',
            'bots.name_required': '❌ Name required',
            'bots.delete_confirm': 'Delete this bot?',
            'bots.logs': 'Logs',
            'bots.lines': 'line(s)',
            'bots.no_logs': 'No logs available — Start the bot to see logs here',
            'bots.editor': '✏️ Editor',
            'bots.save_hint': 'Ctrl+S to save',
            'bots.saved': '✅ Saved!',
            'bots.loading': '⏳ Loading bots...',
            'bots.analysis': 'Analysis',

            // Settings
            'settings.title': '⚙️ Settings',
            'settings.users': '👥 Users',
            'settings.language': '🌐 Language',
            'settings.lang_desc': 'Choose the interface language',
            'settings.french': '🇫🇷 Français',
            'settings.english': '🇬🇧 English',
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
        // Re-rendre la vue active pour appliquer les traductions
        if (typeof App !== 'undefined' && App.currentView) {
            App.navigateTo(App.currentView);
        }
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
