/**
 * Modules.js — Gestion du hub de modules.
 * 
 * Charge la liste des modules depuis l'API et affiche les cartes
 * dans le hub principal. Gère la navigation entre les modules.
 */

const Modules = {
    // Mapping module ID → clé de traduction
    _nameKeys: {
        game_server: 'modules.game_servers',
        bots: 'modules.bots',
        files: 'modules.files',
        media: 'modules.media',
        web: 'modules.web',
        network: 'modules.network',
    },
    _descKeys: {
        game_server: 'modules.game_servers_desc',
        bots: 'modules.bots_desc',
        files: 'modules.files_desc',
        media: 'modules.media_desc',
        web: 'modules.web_desc',
        network: 'modules.network_desc',
    },

    /**
     * Charge et affiche les modules dans le hub.
     */
    async loadHub() {
        const response = await Auth.apiCall('/api/modules/');
        if (!response) return;

        const data = await response.json();
        this.renderHub(data.modules);
    },

    /**
     * Génère le HTML des cartes de modules.
     */
    renderHub(modules) {
        const grid = document.getElementById('modules-grid');
        if (!grid) return;

        grid.innerHTML = modules.map(mod =>{
            const name = this._nameKeys[mod.id] ? Lang.t(this._nameKeys[mod.id]) : mod.name;
            const desc = this._descKeys[mod.id] ? Lang.t(this._descKeys[mod.id]) : mod.description;
            const badge = mod.enabled ? Lang.t('modules.active') : Lang.t('modules.soon');

            return `
            <div class="module-card ${mod.enabled ? '' : 'disabled'}" 
                 style="--module-color: ${mod.color}"
                 onclick="${mod.enabled ? `App.navigateTo('${mod.id}')` : ''}"
                 id="module-${mod.id}">
                <span class="module-badge ${mod.enabled ? 'active' : 'coming-soon'}">
                    ${badge}
                </span>
                <span class="module-icon">${mod.icon}</span>
                <div class="module-name">${name}</div>
                <div class="module-description">${desc}</div>
            </div>`;
        }).join('');
    },
};

