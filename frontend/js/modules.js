/**
 * Modules.js — Gestion du hub de modules.
 * 
 * Charge la liste des modules depuis l'API et affiche les cartes
 * dans le hub principal. Gère la navigation entre les modules.
 */

const Modules = {
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

        grid.innerHTML = modules.map(mod => `
            <div class="module-card ${mod.enabled ? '' : 'disabled'}" 
                 style="--module-color: ${mod.color}"
                 onclick="${mod.enabled ? `App.navigateTo('${mod.id}')` : ''}"
                 id="module-${mod.id}">
                <span class="module-badge ${mod.enabled ? 'active' : 'coming-soon'}">
                    ${mod.enabled ? 'Actif' : 'Bientôt'}
                </span>
                <span class="module-icon">${mod.icon}</span>
                <div class="module-name">${mod.name}</div>
                <div class="module-description">${mod.description}</div>
            </div>
        `).join('');
    },
};
