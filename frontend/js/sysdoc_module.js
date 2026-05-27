/**
 * SysDocModule — Diagnostic Bot intégré dans OmenServer.
 *
 * Affiche les métriques temps réel d'un agent Windows/macOS connecté via
 * WebSocket /ws/sysdoc/viewer/{username}. Reprend le design du dashboard
 * standalone (bot problème) mais branché sur l'auth OmenServer (JWT user).
 *
 * Sections :
 *   - Indice de souffrance + RAM globale + RAM fantôme (3 stat-cards Bento)
 *   - Décomposition mémoire (Σ RSS + delta fantôme)
 *   - Trousse de premiers soins (3 tiers : safe/moderate/risky)
 *   - Processus groupés par app (collapsible, RAM cumulée par groupe)
 *   - Journal d'activité (events feed)
 *
 * Protocol :
 *   - msg.type = "metrics"          → render RAM + suffering + processes
 *   - msg.type = "agent_status"     → online/offline indicator
 *   - msg.type = "actions_catalog"  → renderActionsCatalog (la trousse)
 *   - msg.type = "action_result"    → log dans le journal
 *   - msg.type = "command_result"   → log dans le journal
 */

const SysDocModule = {
    _socket: null,
    _reconnectTimer: null,
    _openGroups: new Set(),
    _username: null,
    // États reçus de l'agent (séparés volontairement) :
    //   _agentOnline = WS agent connecté au hub ? (info viewer ← hub)
    //   _monitoringActive = la boucle metrics 5s tourne-t-elle côté agent ?
    //                       (info viewer ← agent via msg `agent_state`)
    // État par machine — un user peut avoir N machines (Mac + Windows + ...).
    // _machines[id] = { agentOnline, monitoringActive }
    _machines: {},
    _selectedMachine: null,
    // Config récupérée depuis /api/sysdoc/me (username, hub_url, is_admin, secret_key)
    _config: null,
    _showInstallPanel: false,
    // Résultat de la dernière exécution par action_id (pour afficher
    // "Dernière exécution : ..." sous le bouton et éviter le doute UX
    // "j'ai cliqué, mais l'option est toujours là").
    _lastResults: {},

    async render(container) {
        const user = Auth.getUser();
        if (!user) {
            container.innerHTML = '<p style="padding:40px;color:var(--text-muted);">Session expirée — reconnecte-toi.</p>';
            return;
        }
        this._username = user.username;
        const t = (k) => (typeof Lang !== 'undefined' ? Lang.t(k) : k);

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0;">${t('sysdoc.title') || 'Diagnostic système'}</h1>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:4px;">
                        ${t('sysdoc.subtitle') || "RAM, processus, indice de souffrance — agent local"}
                        · <span class="mono" id="sysdoc-username">${this._username}</span>
                    </p>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <span id="sysdoc-conn" class="conn-pill">${t('sysdoc.connecting') || 'Connexion…'}</span>
                    <button class="btn btn-secondary" onclick="App.navigateTo('hub')">${t('common.back_hub') || 'Retour'}</button>
                </div>
            </div>

            <!-- Sélecteur de machines (visible quand >1 machine connectée) -->
            <div id="sysdoc-machine-selector" class="sysdoc-machine-selector" style="display:none;"></div>

            <!-- Overlay "Démarrer le monitoring" — visible quand l'agent est idle -->
            <div id="sysdoc-start-overlay" class="sysdoc-start-overlay" style="display:none;">
                <div class="sysdoc-start-card">
                    <div class="sysdoc-start-icon">▶</div>
                    <h2 class="sysdoc-start-title">${t('sysdoc.start_title') || 'Monitoring en pause'}</h2>
                    <p class="sysdoc-start-desc">
                        ${t('sysdoc.start_desc') || "L'agent est connecté mais n'envoie pas de données pour économiser CPU/réseau. Clique pour activer le monitoring temps réel."}
                    </p>
                    <button id="sysdoc-start-btn" class="btn success" style="font-size:14px;padding:10px 24px;">
                        ▶ ${t('sysdoc.start_btn') || 'Démarrer le monitoring'}
                    </button>
                    <p class="sysdoc-start-hint">
                        ${t('sysdoc.start_hint') || "Le monitoring s'arrête automatiquement quand tu quittes cet onglet."}
                    </p>
                </div>
            </div>

            <!-- Vue d'ensemble — 4 cartes Bento -->
            <div class="bento-overview" id="sysdoc-overview">
                <div class="stat-card big">
                    <div class="label">${t('sysdoc.suffering_index') || 'Indice de souffrance'}</div>
                    <div class="suffering">
                        <span id="sysdoc-suffering-val" class="suffering-value">0</span>
                        <span class="suffering-scale">/ 100</span>
                    </div>
                    <div id="sysdoc-suffering-bar" class="suffering-bar"><span></span></div>
                    <span class="hint">0–39 ${t('sysdoc.healthy') || 'sain'} · 40–69 ${t('sysdoc.warn') || 'attention'} · 70+ ${t('sysdoc.critical') || 'critique'}</span>
                </div>
                <div class="stat-card">
                    <div class="label">${t('sysdoc.ram_global') || 'RAM globale'}</div>
                    <div class="value"><span id="sysdoc-ram-pct">—</span><span class="unit">%</span></div>
                    <div class="hint mono"><span id="sysdoc-ram-used">—</span> / <span id="sysdoc-ram-total">—</span></div>
                </div>
                <div class="stat-card">
                    <div class="label">${t('sysdoc.ram_phantom') || 'RAM fantôme'}</div>
                    <div class="value mono" id="sysdoc-ram-phantom">—</div>
                    <div class="hint">${t('sysdoc.phantom_hint') || 'Kernel / non-paged pool / drivers'}</div>
                </div>
            </div>

            <!-- Décomposition mémoire -->
            <div class="card" style="margin-top:20px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <h2 style="margin:0;font-size:14px;font-weight:600;">${t('sysdoc.memory_breakdown') || 'Décomposition mémoire'}</h2>
                    <span class="mono" style="color:var(--text-dim);font-size:12px;">${t('sysdoc.last_update') || 'dernière mesure'} <span id="sysdoc-last-update">—</span></span>
                </div>
                <div class="bento-overview" style="grid-template-columns:1fr 1fr;">
                    <div class="stat-card">
                        <div class="label">${t('sysdoc.sum_rss') || 'Σ processus actifs (RSS)'}</div>
                        <div class="value mono" id="sysdoc-ram-process">—</div>
                        <div class="hint">${t('sysdoc.sum_rss_hint') || 'Somme du Resident Set Size'}</div>
                    </div>
                    <div class="stat-card">
                        <div class="label">${t('sysdoc.phantom_diff') || 'Différence (fantôme)'}</div>
                        <div class="value mono" id="sysdoc-ram-phantom-2">—</div>
                        <div class="hint warn">${t('sysdoc.phantom_warn') || 'RAM utilisée mais non attribuée à un processus userland'}</div>
                    </div>
                </div>
            </div>

            <!-- Trousse de premiers soins (3 tiers) -->
            <div class="card" style="margin-top:20px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <h2 style="margin:0;font-size:14px;font-weight:600;">${t('sysdoc.kit_title') || 'Trousse de premiers soins'}</h2>
                    <span style="color:var(--text-muted);font-size:12px;">${t('sysdoc.kit_subtitle') || '3 niveaux de risque · safe = auto · moderate = confirmation · risky = instructions'}</span>
                </div>
                <div class="kit-grid">
                    <div class="kit-col safe">
                        <div class="kit-col-header">
                            <span class="kit-col-title">🟢 ${t('sysdoc.tier_safe') || 'Safe — auto'}</span>
                            <span class="kit-col-sub">${t('sysdoc.tier_safe_hint') || 'exécuté direct'}</span>
                        </div>
                        <div id="sysdoc-kit-safe" class="kit-empty">${t('common.loading') || 'Chargement…'}</div>
                    </div>
                    <div class="kit-col moderate">
                        <div class="kit-col-header">
                            <span class="kit-col-title">🟡 ${t('sysdoc.tier_moderate') || 'Modéré — confirmer'}</span>
                            <span class="kit-col-sub">${t('sysdoc.tier_moderate_hint') || 'interrompt une session'}</span>
                        </div>
                        <div id="sysdoc-kit-moderate" class="kit-empty">${t('common.loading') || 'Chargement…'}</div>
                    </div>
                    <div class="kit-col risky">
                        <div class="kit-col-header">
                            <span class="kit-col-title">🔴 ${t('sysdoc.tier_risky') || 'Risqué — instructions'}</span>
                            <span class="kit-col-sub">${t('sysdoc.tier_risky_hint') || "agent n'exécute pas"}</span>
                        </div>
                        <div id="sysdoc-kit-risky" class="kit-empty">${t('common.loading') || 'Chargement…'}</div>
                    </div>
                </div>
            </div>

            <!-- Processus suspensibles groupés -->
            <div class="card" style="margin-top:20px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <h2 style="margin:0;font-size:14px;font-weight:600;">
                        ${t('sysdoc.procs_title') || 'Processus suspensibles'}
                        <span class="badge mono" id="sysdoc-proc-count">0</span>
                        <span class="badge mono" id="sysdoc-group-count">0 groupes</span>
                    </h2>
                    <span style="color:var(--text-muted);font-size:12px;">${t('sysdoc.procs_subtitle') || "Groupés par app — click sur l'en-tête pour déplier"}</span>
                </div>
                <div class="proc-list-wrap">
                    <table class="proc-table">
                        <thead>
                            <tr>
                                <th style="width:80px;">PID</th>
                                <th>${t('sysdoc.col_app_proc') || 'Application / Processus'}</th>
                                <th style="width:90px;text-align:right;">RAM</th>
                                <th style="width:110px;">${t('sysdoc.col_status') || 'Statut'}</th>
                                <th style="width:160px;text-align:right;padding-right:12px;">${t('sysdoc.col_action') || 'Action'}</th>
                            </tr>
                        </thead>
                        <tbody id="sysdoc-proc-tbody">
                            <tr class="empty-row"><td colspan="5">${t('sysdoc.waiting_agent') || "En attente de l'agent…"}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Modal Bento (réutilisable pour confirmations moderate / bulk suspend) -->
            <div id="sysdoc-modal-backdrop" class="modal-backdrop" role="dialog" aria-modal="true">
                <div class="modal">
                    <div class="modal-header">
                        <span class="badge warn">${t('sysdoc.confirmation_required') || 'Confirmation requise'}</span>
                    </div>
                    <h3 id="sysdoc-modal-title" class="modal-title">—</h3>
                    <div id="sysdoc-modal-body" class="modal-body">—</div>
                    <div class="modal-actions">
                        <button id="sysdoc-modal-cancel" class="btn">${t('common.cancel') || 'Annuler'}</button>
                        <button id="sysdoc-modal-confirm" class="btn warn">${t('common.confirm') || 'Confirmer'}</button>
                    </div>
                </div>
            </div>

            <!-- Journal -->
            <div class="card" style="margin-top:20px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                    <h2 style="margin:0;font-size:14px;font-weight:600;">${t('sysdoc.journal') || 'Journal'}</h2>
                    <span style="color:var(--text-muted);font-size:12px;">${t('sysdoc.journal_sub') || 'Connexions, commandes, résultats agent'}</span>
                </div>
                <div id="sysdoc-events" class="events-feed"></div>
            </div>
        `;

        this._bindModal();
        this._bindStartButton();
        this._refreshOverlay();
        this._fetchConfig();
        this._connect();
    },

    async _fetchConfig() {
        try {
            const r = await Auth.apiCall('/api/sysdoc/me');
            if (r && r.ok) {
                this._config = await r.json();
            }
        } catch (e) {
            console.warn('[sysdoc] fetch /api/sysdoc/me failed', e);
        }
    },

    // ---------- Install panel (OS-aware copy/paste commands) ----------
    _detectOS() {
        const ua = (navigator.userAgent || '').toLowerCase();
        if (ua.includes('mac')) return 'macos';
        if (ua.includes('windows') || ua.includes('win32') || ua.includes('win64')) return 'windows';
        if (ua.includes('linux')) return 'linux';
        return 'unknown';
    },

    _renderInstallHTML() {
        const os = this._detectOS();
        const secret = (this._config && this._config.secret_key) || '<SECRET_KEY_DU_HUB>';
        const username = (this._config && this._config.username) || this._username;
        const hubUrl = (this._config && this._config.hub_url) || (location.origin.replace(/^http/, 'ws') + '/ws/sysdoc');
        const isAdmin = !!(this._config && this._config.is_admin);
        const hasMachines = Object.keys(this._machines).length > 0;

        const headline = hasMachines
            ? "Ajouter un nouveau PC à ton diagnostic"
            : "Aucun agent connecté pour ton compte";
        const intro = hasMachines
            ? `Tu as déjà <strong>${Object.keys(this._machines).length}</strong> machine(s) connectée(s). Pour ajouter ce PC ou un autre, suis les étapes pour l'OS choisi.`
            : `Pour voir les diagnostics, installe l'agent sur le PC que tu veux superviser. Suis les étapes pour ton OS — c'est ~2 minutes.`;

        const closeBtn = hasMachines
            ? `<button class="btn" style="position:absolute;top:12px;right:12px;" onclick="SysDocModule._closeInstallPanel()">Fermer</button>`
            : '';

        const secretNote = isAdmin
            ? `<p class="install-hint">Tu es admin — le <strong>SECRET_KEY</strong> est pré-rempli ci-dessous.</p>`
            : `<p class="install-hint">Tu n'es pas admin — demande à un admin de te transmettre le <strong>SECRET_KEY</strong> par canal sécurisé.</p>`;

        return `
            ${closeBtn}
            <div class="install-header">
                <h2 class="install-title">📦 ${headline}</h2>
                <p class="install-intro">${intro}</p>
                ${secretNote}
            </div>

            <div class="install-tabs">
                <button class="install-tab ${os === 'macos' ? 'active' : ''}" data-os="macos">🍎 macOS</button>
                <button class="install-tab ${os === 'windows' ? 'active' : ''}" data-os="windows">🪟 Windows</button>
                <button class="install-tab ${os === 'linux' ? 'active' : ''}" data-os="linux">🐧 Linux</button>
            </div>

            <div class="install-content">
                ${this._renderInstallContent(os, { username, hubUrl, secret, isAdmin })}
            </div>
        `;
    },

    _renderInstallContent(os, ctx) {
        if (os === 'macos') return this._installMacOS(ctx);
        if (os === 'windows') return this._installWindows(ctx);
        if (os === 'linux') return this._installLinux(ctx);
        return `<p>OS non détecté. Voir <code>tools/diagnostic_agent/README.md</code> du repo.</p>`;
    },

    _installMacOS(ctx) {
        const cd = `cd "/Users/$(whoami)/omenserver-diagnostic-agent"`;
        const clone = `git clone https://github.com/Massii-08/OmenServer.git "/Users/$(whoami)/omenserver-diagnostic-agent-repo" && mkdir -p "/Users/$(whoami)/omenserver-diagnostic-agent" && cp -R "/Users/$(whoami)/omenserver-diagnostic-agent-repo/tools/diagnostic_agent/"* "/Users/$(whoami)/omenserver-diagnostic-agent/"`;
        const setup = `cd "/Users/$(whoami)/omenserver-diagnostic-agent" && ./setup_macos.sh`;
        // Tout-en-un (single block) — l'utilisateur n'aura qu'à taper le mot de passe macOS et coller les 3 réponses au prompt
        const allInOne = `# === Diagnostic Agent macOS — install one-shot ===
git clone https://github.com/Massii-08/OmenServer.git /tmp/omenserver-clone 2>/dev/null || (cd /tmp/omenserver-clone && git pull)
mkdir -p ~/omenserver-diagnostic-agent
cp -R /tmp/omenserver-clone/tools/diagnostic_agent/. ~/omenserver-diagnostic-agent/
cd ~/omenserver-diagnostic-agent
chmod +x setup_macos.sh
./setup_macos.sh`;

        return `
            <ol class="install-steps">
                <li>
                    <strong>Ouvrir Terminal</strong> (Cmd+Espace, taper <code>Terminal</code>)
                </li>
                <li>
                    <strong>Copier-coller ce bloc</strong> et appuyer Entrée :
                    ${this._codeBlock(allInOne, 'install-macos-all')}
                </li>
                <li>
                    Le script va te demander 3 valeurs :
                    <ul class="install-prompts">
                        <li><strong>Username OmenServer :</strong> <code class="copyable" data-copy="${this._escape(ctx.username)}">${this._escape(ctx.username)}</code> <button class="install-copy-btn" data-copy="${this._escape(ctx.username)}">Copier</button></li>
                        <li><strong>URL hub :</strong> appuie juste Entrée pour le défaut (<code>${this._escape(ctx.hubUrl)}</code>)</li>
                        <li><strong>SECRET_KEY :</strong> ${ctx.isAdmin ? `colle cette valeur :<br><code class="copyable" data-copy="${this._escape(ctx.secret)}">${this._escape(ctx.secret)}</code> <button class="install-copy-btn" data-copy="${this._escape(ctx.secret)}">Copier</button>` : `demande à un admin de te le transmettre`}</li>
                    </ul>
                </li>
                <li>
                    Fini ! L'agent s'installe comme <strong>LaunchAgent</strong> (auto-start au login). Cette page va se mettre à jour dans quelques secondes.
                </li>
            </ol>
            <details class="install-advanced">
                <summary>Commandes utiles ensuite</summary>
                ${this._codeBlock(`./setup_macos.sh status   # voir si l'agent tourne
./setup_macos.sh logs     # tail des logs en live
./setup_macos.sh stop     # arrêter
./setup_macos.sh restart  # bounce
./setup_macos.sh uninstall  # désinstaller`, 'install-macos-tips')}
            </details>
        `;
    },

    _installWindows(ctx) {
        const cmd = `:: === Diagnostic Agent Windows — install ===
:: 1. Ouvrir PowerShell ou cmd
:: 2. Naviguer où tu veux installer (ex: cd %USERPROFILE%)
git clone https://github.com/Massii-08/OmenServer.git
cd OmenServer\\tools\\diagnostic_agent
setup_windows.bat`;
        return `
            <ol class="install-steps">
                <li>
                    Avoir <strong>Python 3.9+</strong> installé (<a href="https://www.python.org/downloads/" target="_blank">python.org</a>, coche bien "Add Python to PATH")
                </li>
                <li>
                    Avoir <strong>git</strong> installé (<a href="https://git-scm.com/download/win" target="_blank">git-scm.com</a>)
                </li>
                <li>
                    Ouvrir <strong>PowerShell</strong> ou <strong>cmd</strong> et copier-coller :
                    ${this._codeBlock(cmd, 'install-win-clone')}
                </li>
                <li>
                    Le script va demander 3 valeurs :
                    <ul class="install-prompts">
                        <li><strong>Username OmenServer :</strong> <code class="copyable" data-copy="${this._escape(ctx.username)}">${this._escape(ctx.username)}</code> <button class="install-copy-btn" data-copy="${this._escape(ctx.username)}">Copier</button></li>
                        <li><strong>URL hub :</strong> appuie Entrée pour le défaut (<code>${this._escape(ctx.hubUrl)}</code>)</li>
                        <li><strong>SECRET_KEY :</strong> ${ctx.isAdmin ? `colle cette valeur :<br><code class="copyable" data-copy="${this._escape(ctx.secret)}">${this._escape(ctx.secret)}</code> <button class="install-copy-btn" data-copy="${this._escape(ctx.secret)}">Copier</button>` : `demande à un admin`}</li>
                    </ul>
                </li>
                <li>
                    Lancer l'agent : ${this._codeBlock('run.bat', 'install-win-run')}
                </li>
            </ol>
            <details class="install-advanced">
                <summary>Installation en service Windows (auto-start au boot)</summary>
                <p>Pour que l'agent démarre automatiquement au boot, installe-le comme service via NSSM :</p>
                <ol>
                    <li>Télécharger <a href="https://nssm.cc/download" target="_blank">NSSM</a></li>
                    <li>Placer <code>nssm.exe</code> dans le dossier <code>diagnostic_agent/</code> ou dans ton PATH</li>
                    <li>Clic-droit sur <code>install_service.bat</code> → "Exécuter en tant qu'administrateur"</li>
                </ol>
            </details>
        `;
    },

    _installLinux(ctx) {
        const cmd = `# === Diagnostic Agent Linux — install ===
git clone https://github.com/Massii-08/OmenServer.git ~/omenserver-clone
mkdir -p ~/omenserver-diagnostic-agent
cp -R ~/omenserver-clone/tools/diagnostic_agent/. ~/omenserver-diagnostic-agent/
cd ~/omenserver-diagnostic-agent
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cat > .env <<EOF
OMEN_AGENT_USERNAME=${ctx.username}
OMEN_HUB_URL=${ctx.hubUrl}
OMEN_JWT_SECRET=${ctx.secret}
EOF
chmod 600 .env
./venv/bin/python -u main.py`;

        return `
            <ol class="install-steps">
                <li>
                    Avoir Python 3.9+ et git installés (apt/yum/pacman selon ta distro)
                </li>
                <li>
                    Copier-coller ce bloc dans ton terminal :
                    ${this._codeBlock(cmd, 'install-linux')}
                </li>
                <li>
                    L'agent tourne en foreground. Pour systemd (auto-start au boot), suis le pattern du <a href="https://github.com/Massii-08/OmenServer/blob/main/tools/diagnostic_agent/README.md" target="_blank">README</a> (création de <code>omen-diagnostic.service</code>).
                </li>
            </ol>
        `;
    },

    _codeBlock(code, id) {
        const safe = this._escape(code);
        return `
            <div class="install-code-block">
                <button class="install-copy-btn" data-copy-id="${id}">Copier</button>
                <pre id="${id}"><code>${safe}</code></pre>
            </div>
        `;
    },

    _bindInstallPanel() {
        // Tabs OS
        document.querySelectorAll('.install-tab').forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.install-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const ctx = {
                    username: (this._config && this._config.username) || this._username,
                    hubUrl: (this._config && this._config.hub_url) || (location.origin.replace(/^http/, 'ws') + '/ws/sysdoc'),
                    secret: (this._config && this._config.secret_key) || '<SECRET_KEY_DU_HUB>',
                    isAdmin: !!(this._config && this._config.is_admin),
                };
                document.querySelector('.install-content').innerHTML = this._renderInstallContent(tab.dataset.os, ctx);
                this._bindCopyButtons();
            };
        });
        this._bindCopyButtons();
    },

    _bindCopyButtons() {
        document.querySelectorAll('.install-copy-btn, .copyable').forEach(el => {
            el.onclick = async (e) => {
                e.stopPropagation();
                let text = el.dataset.copy;
                if (!text && el.dataset.copyId) {
                    const target = document.getElementById(el.dataset.copyId);
                    text = target ? target.textContent : '';
                }
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                    const orig = el.textContent;
                    el.textContent = '✓ Copié';
                    setTimeout(() => { el.textContent = orig; }, 1500);
                    if (typeof Toast !== 'undefined') Toast.success('Copié dans le presse-papier');
                } catch (err) {
                    if (typeof Toast !== 'undefined') Toast.error('Copie échouée — copie manuellement');
                }
            };
        });
    },

    _openInstallPanel() {
        this._showInstallPanel = true;
        this._refreshOverlay();
    },

    _closeInstallPanel() {
        this._showInstallPanel = false;
        this._refreshOverlay();
    },

    _bindStartButton() {
        const btn = document.getElementById('sysdoc-start-btn');
        if (!btn) return;
        btn.onclick = () => {
            const machineId = this._selectedMachine;
            const state = machineId ? this._machines[machineId] : null;
            if (!state || !state.agentOnline) {
                this._logEvent('err', "Agent pas connecté — installe-le d'abord");
                return;
            }
            this._logEvent('info', `→ START_MONITORING demandé pour ${machineId}`);
            if (this._send({ command: 'START_MONITORING', target_machine: machineId })) {
                btn.disabled = true;
                btn.textContent = '⏳ Démarrage…';
            }
        };
    },

    _refreshOverlay() {
        const overlay = document.getElementById('sysdoc-start-overlay');
        if (!overlay) return;
        const card = overlay.querySelector('.sysdoc-start-card');
        if (!card) return;

        // État de la machine sélectionnée
        const machineId = this._selectedMachine;
        const state = machineId ? this._machines[machineId] : null;
        const agentOnline = state ? state.agentOnline : false;
        const monitoringActive = state ? state.monitoringActive : false;

        // Cas 1 : monitoring actif → overlay caché, on affiche les données
        if (monitoringActive) {
            overlay.style.display = 'none';
            return;
        }

        // Cas 2 : aucune machine OU agent hors ligne OU user demande "Ajouter un PC"
        // → afficher le panneau d'install avec commandes prêtes à copier-coller
        if (!machineId || !agentOnline || this._showInstallPanel) {
            overlay.style.display = 'flex';
            card.innerHTML = this._renderInstallHTML();
            this._bindInstallPanel();
            return;
        }

        // Cas 3 : agent online mais monitoring inactif → bouton Démarrer
        const t = (k) => (typeof Lang !== 'undefined' ? Lang.t(k) : k);
        overlay.style.display = 'flex';
        card.innerHTML = `
            <div class="sysdoc-start-icon">▶</div>
            <h2 class="sysdoc-start-title">${t('sysdoc.start_title') || 'Monitoring en pause'}</h2>
            <p class="sysdoc-start-desc">
                ${t('sysdoc.start_desc') || "L'agent est connecté mais n'envoie pas de données pour économiser CPU/réseau. Clique pour activer le monitoring temps réel."}
            </p>
            <button id="sysdoc-start-btn" class="btn success" style="font-size:14px;padding:10px 24px;">
                ▶ ${t('sysdoc.start_btn') || 'Démarrer le monitoring'}
            </button>
            <p class="sysdoc-start-hint">
                ${t('sysdoc.start_hint') || "Le monitoring s'arrête automatiquement quand tu quittes cet onglet."}
            </p>
        `;
        // Re-bind le bouton (innerHTML a recréé le bouton)
        this._bindStartButton();
    },

    unload() {
        // Stop le monitoring de TOUTES les machines actives avant de fermer
        if (this._socket && this._socket.readyState === WebSocket.OPEN) {
            for (const [id, state] of Object.entries(this._machines)) {
                if (state.monitoringActive) {
                    try {
                        this._socket.send(JSON.stringify({
                            command: 'STOP_MONITORING',
                            target_machine: id,
                        }));
                    } catch (_) {}
                }
            }
        }
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._socket) {
            try { this._socket.close(1000, 'view changed'); } catch (_) {}
            this._socket = null;
        }
        this._openGroups.clear();
        this._machines = {};
        this._selectedMachine = null;
    },

    // ---------- Machine selection ----------
    _selectMachine(machineId) {
        if (this._selectedMachine === machineId) return;
        // Si on quitte une machine où le monitoring est actif, on l'arrête
        if (this._selectedMachine && this._machines[this._selectedMachine]?.monitoringActive) {
            this._send({ command: 'STOP_MONITORING', target_machine: this._selectedMachine });
        }
        this._selectedMachine = machineId;
        this._renderMachineSelector();
        this._refreshOverlay();
        // Reset les vues de données quand on change de machine
        this._resetMetricsUI();
        // Si la nouvelle machine est online, query son état + catalogue
        if (this._machines[machineId]?.agentOnline) {
            this._send({ command: 'QUERY_STATE', target_machine: machineId });
            this._send({ command: 'LIST_ACTIONS', target_machine: machineId });
        }
    },

    _renderMachineSelector() {
        const root = document.getElementById('sysdoc-machine-selector');
        if (!root) return;
        const machineIds = Object.keys(this._machines);
        if (machineIds.length === 0) {
            // 0 machine : pas de sélecteur (le panel install prend la place)
            root.style.display = 'none';
            return;
        }
        // ≥1 machine : afficher le sélecteur (même avec 1 machine, pour exposer "+ Ajouter")
        root.style.display = 'flex';
        root.innerHTML = '';
        machineIds.forEach(id => {
            const state = this._machines[id];
            const btn = document.createElement('button');
            btn.className = 'machine-pill' + (id === this._selectedMachine ? ' active' : '');
            btn.innerHTML = `<span class="machine-pill-dot ${state.agentOnline ? 'online' : 'offline'}"></span><span class="machine-pill-name"></span>`;
            btn.querySelector('.machine-pill-name').textContent = id;
            btn.onclick = () => this._selectMachine(id);
            root.appendChild(btn);
        });
        // Bouton "+ Ajouter un PC" toujours visible quand y'a au moins 1 machine
        const addBtn = document.createElement('button');
        addBtn.className = 'machine-pill machine-pill-add';
        addBtn.innerHTML = '<span>+ Ajouter un PC</span>';
        addBtn.onclick = () => this._openInstallPanel();
        root.appendChild(addBtn);
    },

    _resetMetricsUI() {
        // Quand on change de machine, repart de zéro côté UI
        const reset = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        reset('sysdoc-suffering-val', '0');
        reset('sysdoc-ram-pct', '—');
        reset('sysdoc-ram-used', '—');
        reset('sysdoc-ram-total', '—');
        reset('sysdoc-ram-process', '—');
        reset('sysdoc-ram-phantom', '—');
        reset('sysdoc-ram-phantom-2', '—');
        reset('sysdoc-last-update', '—');
        reset('sysdoc-proc-count', '0');
        reset('sysdoc-group-count', '0 groupes');
        const tbody = document.getElementById('sysdoc-proc-tbody');
        if (tbody) tbody.innerHTML = '<tr class="empty-row"><td colspan="5">En attente des données…</td></tr>';
    },

    // ---------- WS lifecycle ----------
    _connect() {
        const token = Auth.getToken && Auth.getToken();
        if (!token) {
            this._setConn('offline', 'Pas de token JWT');
            return;
        }
        const wsBase = location.origin.replace(/^http/, 'ws');
        const url = `${wsBase}/ws/sysdoc/viewer/${encodeURIComponent(this._username)}?token=${encodeURIComponent(token)}`;
        this._setConn('', 'Connexion…');
        try {
            this._socket = new WebSocket(url);
        } catch (err) {
            this._logEvent('err', `Erreur WS : ${err.message || err}`);
            this._scheduleReconnect();
            return;
        }
        this._socket.onopen = () => {
            this._setConn('online', `Hub OK · ${this._username}`);
            this._logEvent('ok', `Connecté au hub en tant que viewer ${this._username}`);
            // Demande l'état du monitoring à l'agent (pour savoir s'il faut
            // afficher le bouton "Démarrer" ou directement les données).
            this._send({ command: 'QUERY_STATE' });
            this._send({ command: 'LIST_ACTIONS' });
        };
        this._socket.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch (_) { return; }
            this._handleMessage(msg);
        };
        this._socket.onerror = () => {
            this._logEvent('err', 'Erreur WebSocket');
        };
        this._socket.onclose = (e) => {
            this._logEvent('warn', `Socket fermée (code ${e.code})`);
            this._socket = null;
            // Ne pas reconnecter si on est sorti du module (unload a tout nettoyé)
            if (App && App.currentView === 'sysdoc') this._scheduleReconnect();
        };
    },

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._setConn('offline', 'Reconnexion dans 3s…');
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connect();
        }, 3000);
    },

    _send(obj) {
        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
            this._logEvent('err', 'Pas de connexion WS active');
            return false;
        }
        // Backend requires target_machine on viewer→agent commands. If the caller
        // didn't specify, use _selectedMachine. If still null, refuse.
        if (!obj.target_machine && this._selectedMachine) {
            obj = { ...obj, target_machine: this._selectedMachine };
        }
        if (!obj.target_machine) {
            this._logEvent('err', 'Aucune machine sélectionnée');
            return false;
        }
        this._socket.send(JSON.stringify(obj));
        return true;
    },

    // ---------- Message handlers ----------
    _handleMessage(msg) {
        if (!msg || !msg.type) return;
        // Tous les messages venant d'un agent sont enrichis avec `machine` par le backend.
        // On ignore les messages d'autres machines que celle sélectionnée pour les
        // updates UI (metrics, agent_state), mais on traite TOUJOURS agent_status et
        // machines_update (qui pilotent la liste des machines).
        const fromMachine = msg.machine || null;
        const isForSelected = !fromMachine || fromMachine === this._selectedMachine;

        switch (msg.type) {
            case 'machines_update': {
                const list = (msg.data && msg.data.machines) || [];
                // Garder ou créer les entrées
                const newMachines = {};
                list.forEach(id => {
                    newMachines[id] = this._machines[id] || { agentOnline: true, monitoringActive: false };
                });
                this._machines = newMachines;
                // Si aucune machine sélectionnée ou la sélectionnée a disparu, prendre la 1ère
                if (!this._selectedMachine || !newMachines[this._selectedMachine]) {
                    this._selectedMachine = list[0] || null;
                    if (this._selectedMachine) {
                        this._send({ command: 'QUERY_STATE', target_machine: this._selectedMachine });
                        this._send({ command: 'LIST_ACTIONS', target_machine: this._selectedMachine });
                    }
                }
                this._renderMachineSelector();
                this._refreshOverlay();
                break;
            }
            case 'metrics':
                if (!isForSelected) break;
                this._updateRam((msg.data || {}).ram);
                this._updateSuffering((msg.data || {}).suffering_index || 0);
                this._updateProcs((msg.data || {}).processes || []);
                document.getElementById('sysdoc-last-update').textContent = new Date().toTimeString().slice(0, 8);
                break;
            case 'agent_status': {
                const machineId = fromMachine || (msg.data && msg.data.machine) || this._selectedMachine;
                if (!machineId) break;
                const online = !!(msg.data && msg.data.online);
                if (!this._machines[machineId]) this._machines[machineId] = { agentOnline: false, monitoringActive: false };
                this._machines[machineId].agentOnline = online;
                if (!online) this._machines[machineId].monitoringActive = false;
                this._renderMachineSelector();
                if (machineId === this._selectedMachine) {
                    if (online) {
                        this._setConn('online', `Agent ${machineId} en ligne`);
                        this._logEvent('ok', `Agent ${machineId} connecté`);
                        this._send({ command: 'LIST_ACTIONS', target_machine: machineId });
                        this._send({ command: 'QUERY_STATE', target_machine: machineId });
                    } else {
                        this._setConn('offline', `Agent ${machineId} hors ligne`);
                        this._logEvent('warn', `Agent ${machineId} déconnecté`);
                    }
                    this._refreshOverlay();
                }
                break;
            }
            case 'agent_state': {
                const machineId = fromMachine || this._selectedMachine;
                if (!machineId) break;
                if (!this._machines[machineId]) this._machines[machineId] = { agentOnline: true, monitoringActive: false };
                this._machines[machineId].monitoringActive = !!(msg.data && msg.data.monitoring);
                if (machineId === this._selectedMachine) {
                    this._logEvent('info', `[${machineId}] Agent state: ${this._machines[machineId].monitoringActive ? 'monitoring ACTIF' : 'IDLE'}`);
                    this._refreshOverlay();
                }
                break;
            }
            case 'actions_catalog':
                this._renderCatalog(((msg.data || {}).actions) || []);
                break;
            case 'command_result': {
                const r = msg.result || {};
                this._logEvent(r.status === 'success' ? 'ok' : 'err', r.message || JSON.stringify(r));
                break;
            }
            case 'action_result': {
                const r = msg.result || {};
                const aid = (msg.data && msg.data.action_id) || '?';
                let line = `[${aid}] ${r.message || JSON.stringify(r)}`;
                if (r.freed_bytes) line += ` (${this._fmtMb(r.freed_bytes / 1048576)})`;
                const success = r.status === 'success';
                this._logEvent(success ? 'ok' : 'err', line);
                // Toast immédiat — sinon l'utilisateur ne voit rien si le journal est hors viewport
                if (typeof Toast !== 'undefined') {
                    const toastMsg = r.message || `Action ${aid} ${success ? 'OK' : 'KO'}`;
                    (success ? Toast.success : Toast.error)(toastMsg);
                }
                // Mémoriser le résultat pour affichage inline sous le bouton
                this._lastResults[aid] = {
                    when: Date.now(),
                    message: r.message || '',
                    success: success,
                };
                this._renderActionResult(aid);
                // Re-activer les boutons qui étaient en "⏳ En cours…" pour cette action
                this._restoreActionButton(aid);
                break;
            }
        }
    },

    // ---------- Rendering ----------
    _setConn(state, label) {
        const el = document.getElementById('sysdoc-conn');
        if (!el) return;
        el.className = 'conn-pill ' + state;
        el.textContent = label;
    },

    _logEvent(type, msg) {
        const root = document.getElementById('sysdoc-events');
        if (!root) return;
        const now = new Date();
        const ts = now.toTimeString().slice(0, 8);
        const row = document.createElement('div');
        row.className = 'ev';
        row.innerHTML = `<span class="ts">${ts}</span><span class="typ ${type}">${type.toUpperCase()}</span><span class="msg"></span>`;
        row.querySelector('.msg').textContent = msg;
        root.prepend(row);
        while (root.children.length > 40) root.removeChild(root.lastChild);
    },

    _severity(v) { return v < 40 ? '' : (v < 70 ? 'warn' : 'err'); },

    _updateSuffering(v) {
        const valEl = document.getElementById('sysdoc-suffering-val');
        if (!valEl) return;
        valEl.textContent = v;
        const cls = this._severity(v);
        valEl.className = 'suffering-value ' + cls;
        const bar = document.querySelector('#sysdoc-suffering-bar > span');
        if (bar) { bar.style.width = Math.min(100, v) + '%'; bar.className = cls; }
    },

    _fmtMb(mb) {
        if (mb == null || isNaN(mb)) return '—';
        if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
        if (mb >= 10)   return Math.round(mb) + ' MB';
        return mb.toFixed(1) + ' MB';
    },

    _updateRam(ram) {
        if (!ram) return;
        document.getElementById('sysdoc-ram-pct').textContent = (ram.percent_used || 0).toFixed(1);
        document.getElementById('sysdoc-ram-used').textContent = this._fmtMb(ram.used_ram_mb);
        document.getElementById('sysdoc-ram-total').textContent = this._fmtMb(ram.total_ram_mb);
        document.getElementById('sysdoc-ram-process').textContent = this._fmtMb(ram.sum_process_memory_mb);
        const phantom = this._fmtMb(ram.phantom_ram_mb);
        document.getElementById('sysdoc-ram-phantom').textContent = phantom;
        document.getElementById('sysdoc-ram-phantom-2').textContent = phantom;
    },

    // ---------- Process grouping & rendering ----------
    _groupProcesses(processes) {
        const map = new Map();
        processes.forEach(p => {
            const key = p.app_group || p.name || 'Inconnu';
            if (!map.has(key)) {
                map.set(key, { name: key, items: [], total_mb: 0, running: 0, suspended: 0 });
            }
            const g = map.get(key);
            g.items.push(p);
            g.total_mb += (typeof p.memory_mb === 'number') ? p.memory_mb : 0;
            if (p.status === 'running' || p.status === 'sleeping') g.running++;
            else g.suspended++;
        });
        const list = Array.from(map.values());
        list.sort((a, b) => b.total_mb - a.total_mb || b.items.length - a.items.length);
        list.forEach(g => g.items.sort((a, b) => (b.memory_mb || 0) - (a.memory_mb || 0)));
        return list;
    },

    _updateProcs(processes) {
        const tbody = document.getElementById('sysdoc-proc-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!processes || processes.length === 0) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Aucun processus</td></tr>';
            document.getElementById('sysdoc-proc-count').textContent = '0';
            document.getElementById('sysdoc-group-count').textContent = '0 groupes';
            return;
        }
        const groups = this._groupProcesses(processes);
        const frag = document.createDocumentFragment();
        groups.forEach(group => {
            const isOpen = this._openGroups.has(group.name);
            frag.appendChild(this._buildGroupHeader(group, isOpen));
            group.items.forEach(p => frag.appendChild(this._buildGroupItem(p, group.name, isOpen)));
        });
        tbody.appendChild(frag);
        document.getElementById('sysdoc-proc-count').textContent = String(processes.length);
        document.getElementById('sysdoc-group-count').textContent = `${groups.length} groupes`;
    },

    _buildGroupHeader(group, isOpen) {
        const tr = document.createElement('tr');
        tr.className = 'group-header' + (isOpen ? ' open' : '');
        tr.dataset.group = group.name;

        const tdCaret = document.createElement('td');
        tdCaret.className = 'mono dim';
        tdCaret.innerHTML = '<span class="caret">›</span>';
        tr.appendChild(tdCaret);

        const tdName = document.createElement('td');
        tdName.className = 'gh-name';
        tdName.innerHTML = `<strong></strong> <span class="group-count-pill">${group.items.length}</span>`;
        tdName.querySelector('strong').textContent = group.name;
        tr.appendChild(tdName);

        const tdMem = document.createElement('td');
        tdMem.className = 'gh-mem';
        tdMem.textContent = this._fmtMb(group.total_mb);
        tr.appendChild(tdMem);

        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = group.running > 0
            ? `<span class="badge online">${group.running} actifs</span>`
            : `<span class="badge stopped">${group.suspended} gelés</span>`;
        tr.appendChild(tdStatus);

        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'right';
        tdAction.style.paddingRight = '12px';
        const btn = document.createElement('button');
        if (group.running > 0) {
            btn.className = 'btn warn';
            btn.textContent = `Geler ${group.running}`;
            btn.onclick = (e) => {
                e.stopPropagation();
                const pids = group.items
                    .filter(p => p.status === 'running' || p.status === 'sleeping')
                    .map(p => p.pid);
                this._openModal({
                    title: `Geler le groupe « ${group.name} »`,
                    body: `Cette action gèle ${pids.length} processus du groupe « ${group.name} » (${this._fmtMb(group.total_mb)} de RAM cumulée). Réversible via Reprendre. Confirmer ?`,
                    confirmLabel: `Geler les ${pids.length}`,
                    onConfirm: () => this._bulkSuspend(pids, group.name),
                });
            };
        } else {
            btn.className = 'btn';
            btn.textContent = 'Tous gelés';
            btn.disabled = true;
        }
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);

        tr.onclick = (e) => {
            if (e.target.closest('button')) return;
            const nowOpen = !this._openGroups.has(group.name);
            if (nowOpen) this._openGroups.add(group.name);
            else this._openGroups.delete(group.name);
            tr.classList.toggle('open', nowOpen);
            document.querySelectorAll(`tr.group-item[data-group="${CSS.escape(group.name)}"]`)
                .forEach(r => r.classList.toggle('open', nowOpen));
        };
        return tr;
    },

    _buildGroupItem(proc, groupName, isOpen) {
        const tr = document.createElement('tr');
        tr.className = 'group-item' + (isOpen ? ' open' : '');
        tr.dataset.group = groupName;
        const isRunning = proc.status === 'running' || proc.status === 'sleeping';

        const cell = (cls, content) => {
            const td = document.createElement('td');
            if (cls) td.className = cls;
            td.textContent = content;
            return td;
        };

        tr.appendChild(cell('mono dim', proc.pid));
        tr.appendChild(cell('gi-name', proc.name || '—'));
        tr.appendChild(cell('gi-mem', this._fmtMb(proc.memory_mb)));

        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = `<span class="badge ${isRunning ? 'online' : 'stopped'}">${this._escape(proc.status || '?')}</span>`;
        tr.appendChild(tdStatus);

        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'right';
        tdAction.style.paddingRight = '12px';
        const btn = document.createElement('button');
        if (isRunning) {
            btn.className = 'btn warn';
            btn.textContent = 'Geler';
            btn.onclick = () => this._send({ command: 'SUSPEND_PROCESS', payload: { pid: proc.pid } });
        } else {
            btn.className = 'btn success';
            btn.textContent = 'Reprendre';
            btn.onclick = () => this._send({ command: 'RESUME_PROCESS', payload: { pid: proc.pid } });
        }
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);
        return tr;
    },

    _runAction(actionId, btn) {
        // Feedback immédiat : spinner sur le bouton, disabled le temps du round-trip
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ En cours…';
        }
        // Toast d'attente pour l'utilisateur qui ne regarde pas la trousse
        if (typeof Toast !== 'undefined') {
            Toast.info(`Action ${actionId} en cours…`);
        }
        this._send({ command: 'RUN_ACTION', payload: { action_id: actionId } });
        // Safety net : si l'agent ne répond pas dans 30s, on restaure le bouton
        setTimeout(() => this._restoreActionButton(actionId), 30000);
    },

    _restoreActionButton(actionId) {
        document.querySelectorAll(`button[data-action-id="${CSS.escape(actionId)}"]`).forEach(btn => {
            btn.disabled = false;
            btn.textContent = btn.dataset.originalLabel || 'Lancer';
        });
    },

    _renderActionResult(actionId) {
        const result = this._lastResults[actionId];
        if (!result) return;
        const slot = document.querySelector(`.kit-action-result[data-action-id="${CSS.escape(actionId)}"]`);
        if (!slot) return;
        const ago = this._relativeTime(result.when);
        const cls = result.success ? 'ok' : 'err';
        const icon = result.success ? '✓' : '✗';
        slot.className = 'kit-action-result ' + cls;
        slot.innerHTML = `<span class="kit-action-result-icon">${icon}</span> <span class="kit-action-result-msg"></span> <span class="kit-action-result-when">· ${ago}</span>`;
        slot.querySelector('.kit-action-result-msg').textContent = result.message;
    },

    _relativeTime(ts) {
        const elapsed = (Date.now() - ts) / 1000;
        if (elapsed < 60)   return 'à l’instant';
        if (elapsed < 3600) return `il y a ${Math.floor(elapsed / 60)} min`;
        if (elapsed < 86400) return `il y a ${Math.floor(elapsed / 3600)} h`;
        return new Date(ts).toLocaleString();
    },

    _bulkSuspend(pids, groupName) {
        if (!pids || pids.length === 0) return;
        if (this._send({ command: 'BULK_SUSPEND', payload: { pids } })) {
            this._logEvent('info', `→ BULK_SUSPEND ${pids.length} PIDs du groupe « ${groupName} »`);
        }
    },

    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    // ---------- Actions catalog (Trousse 3 tiers) ----------
    _renderCatalog(actions) {
        const buckets = { safe: [], moderate: [], risky: [] };
        actions.forEach(a => { if (buckets[a.tier]) buckets[a.tier].push(a); });
        this._renderTierCol('sysdoc-kit-safe',     buckets.safe,     'safe');
        this._renderTierCol('sysdoc-kit-moderate', buckets.moderate, 'moderate');
        this._renderTierCol('sysdoc-kit-risky',    buckets.risky,    'risky');
        this._logEvent('info', `Catalogue chargé (${actions.length} actions)`);
    },

    _renderTierCol(containerId, actions, tier) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.classList.remove('kit-empty');
        container.innerHTML = '';
        if (actions.length === 0) {
            container.className = 'kit-empty';
            container.textContent = `Aucune action ${tier} disponible sur cette plateforme.`;
            return;
        }
        actions.forEach(a => container.appendChild(this._buildActionCard(a, tier)));
    },

    _buildActionCard(action, tier) {
        const card = document.createElement('div');
        card.className = 'kit-action';

        const title = document.createElement('div');
        title.className = 'kit-action-title';
        title.textContent = action.title;
        card.appendChild(title);

        const desc = document.createElement('div');
        desc.className = 'kit-action-desc';
        desc.textContent = action.description;
        card.appendChild(desc);

        if (action.warning) {
            const w = document.createElement('div');
            w.className = 'kit-action-warning';
            w.textContent = '⚠ ' + action.warning;
            card.appendChild(w);
        }

        const actions = document.createElement('div');
        actions.className = 'kit-action-actions';

        if (tier === 'safe') {
            const btn = document.createElement('button');
            btn.className = 'btn success';
            btn.textContent = 'Lancer';
            btn.dataset.actionId = action.id;
            btn.dataset.originalLabel = 'Lancer';
            btn.onclick = () => this._runAction(action.id, btn);
            actions.appendChild(btn);
        } else if (tier === 'moderate') {
            const btn = document.createElement('button');
            btn.className = 'btn warn';
            btn.textContent = 'Lancer (confirmation)';
            btn.dataset.actionId = action.id;
            btn.dataset.originalLabel = 'Lancer (confirmation)';
            btn.onclick = () => this._openModal({
                title: action.title,
                body: action.confirmation_text || `Cette action va exécuter : ${action.description}`,
                confirmLabel: 'Confirmer',
                onConfirm: () => this._runAction(action.id, btn),
            });
            actions.appendChild(btn);
        } else if (tier === 'risky') {
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = 'Voir les étapes';
            const panel = document.createElement('div');
            panel.className = 'kit-instructions';
            const ol = document.createElement('ol');
            (action.instructions || []).forEach(step => {
                const li = document.createElement('li');
                li.innerHTML = step
                    .replace(/`([^`]+)`/g, '<code>$1</code>')
                    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                ol.appendChild(li);
            });
            panel.appendChild(ol);
            const ack = document.createElement('button');
            ack.className = 'btn success';
            ack.textContent = "J'ai fait";
            ack.style.marginTop = '12px';
            ack.onclick = () => {
                this._logEvent('ok', `[${action.id}] marqué comme fait manuellement`);
                panel.classList.remove('open');
                btn.textContent = 'Voir les étapes';
            };
            panel.appendChild(ack);
            btn.onclick = () => {
                const open = panel.classList.toggle('open');
                btn.textContent = open ? 'Masquer les étapes' : 'Voir les étapes';
            };
            actions.appendChild(btn);
            card.appendChild(actions);
            card.appendChild(panel);
            return card;
        }
        card.appendChild(actions);
        // Slot pour résultat de la dernière exécution (rempli par _renderActionResult)
        const resultSlot = document.createElement('div');
        resultSlot.className = 'kit-action-result';
        resultSlot.dataset.actionId = action.id;
        card.appendChild(resultSlot);
        // Si on a déjà un résultat (ex: re-render après reconnect), l'afficher
        if (this._lastResults[action.id]) {
            // Note : on doit attendre que le card soit dans le DOM avant de query
            setTimeout(() => this._renderActionResult(action.id), 0);
        }
        return card;
    },

    // ---------- Modal ----------
    _modalConfirmHandler: null,
    _openModal({ title, body, confirmLabel, onConfirm }) {
        const back = document.getElementById('sysdoc-modal-backdrop');
        if (!back) return;
        document.getElementById('sysdoc-modal-title').textContent = title || 'Confirmation';
        document.getElementById('sysdoc-modal-body').textContent = body || '';
        document.getElementById('sysdoc-modal-confirm').textContent = confirmLabel || 'Confirmer';
        this._modalConfirmHandler = onConfirm || null;
        back.classList.add('open');
    },
    _closeModal() {
        const back = document.getElementById('sysdoc-modal-backdrop');
        if (!back) return;
        back.classList.remove('open');
        this._modalConfirmHandler = null;
    },
    _bindModal() {
        const back = document.getElementById('sysdoc-modal-backdrop');
        if (!back || back.dataset.bound) return;
        back.dataset.bound = '1';
        document.getElementById('sysdoc-modal-cancel').onclick = () => this._closeModal();
        document.getElementById('sysdoc-modal-confirm').onclick = () => {
            const h = this._modalConfirmHandler;
            this._closeModal();
            if (typeof h === 'function') h();
        };
        back.addEventListener('click', (e) => {
            if (e.target === back) this._closeModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && back.classList.contains('open')) this._closeModal();
        });
    },
};
